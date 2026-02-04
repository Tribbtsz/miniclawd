/**
 * Yunhu (YHChat) channel implementation
 *
 * Reference: https://github.com/Daenx/YHChat-Sdk
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { homedir } from "os";
import { FormData } from "formdata-node";
import { fileFromPath } from "formdata-node/file-from-path";
import type { OutboundMessage } from "../../core/types/message.js";
import type { YunhuConfig } from "../../core/types/config.js";
import type {
  YunhuEventVo,
  YunhuEventMessage,
  YunhuMessage,
  YunhuMessageContent,
  YunhuApiResponse,
} from "./yunhu/types.js";
import {
  YUNHU_RECV_TYPE,
  YUNHU_CONTENT_TYPE,
  YUNHU_CHAT_TYPE,
} from "./yunhu/types.js";
import { MessageBus } from "../queue/message-bus.js";
import { BaseChannel } from "./base.js";
import logger from "../../utils/logger.js";

// Configuration constants
const DEFAULT_WEBHOOK_PORT = 18791;
const DEFAULT_WEBHOOK_PATH = "/event/msg";
const DEFAULT_CACHE_TIMEOUT = 3600000; // 1 hour in milliseconds
const API_SUCCESS_CODE = 200;
const API_SUCCESS_MESSAGE = "success";
const MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT = 30000; // 30 seconds
const UPLOAD_TIMEOUT = 60000; // 60 seconds

/**
 * Yunhu channel implementation
 *
 * Receives webhook events from Yunhu via HTTP server
 * Sends messages to Yunhu via API
 */
export class YunhuChannel extends BaseChannel {
  readonly name = "yunhu";
  private server: Server | null = null;
  private apiUrl = "https://chat-go.jwzhd.com/open-apis/v1";
  private mediaCache: Map<string, { key: string; timestamp: number }> = new Map();
  private readonly cacheTimeout = DEFAULT_CACHE_TIMEOUT;

  constructor(config: YunhuConfig, bus: MessageBus) {
    super(config, bus);
  }

  /**
   * Get Yunhu configuration
   */
  private get yunhuConfig(): YunhuConfig {
    return this.config as YunhuConfig;
  }

  /**
   * Get authentication token
   */
  private get token(): string {
    return this.yunhuConfig.token;
  }

  /**
   * Get webhook port
   */
  private get webhookPort(): number {
    return this.yunhuConfig.webhookPort || DEFAULT_WEBHOOK_PORT;
  }

  /**
   * Get webhook path
   */
  private get webhookPath(): string {
    return this.yunhuConfig.webhookPath || DEFAULT_WEBHOOK_PATH;
  }

  /**
   * Start Yunhu channel
   * Start HTTP server to receive webhook events
   */
  async start(): Promise<void> {
    if (!this.token) {
      logger.error("Yunhu bot token not configured");
      return;
    }

    this._running = true;

    // Create HTTP server
    this.server = createServer((req, res) => this.handleRequest(req, res));

    // Listen on specified port
    this.server.listen(this.webhookPort, () => {
      logger.info(
        `Yunhu webhook server listening on port ${this.webhookPort}, path: ${this.webhookPath}`
      );
    });

    // Handle server errors
    this.server.on("error", (error) => {
      logger.error({ error }, "Yunhu webhook server error");
      this._running = false;
    });

    // Keep running
    while (this._running) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /**
   * Stop Yunhu channel
   * Close HTTP server
   */
  async stop(): Promise<void> {
    this._running = false;
    logger.info("Stopping Yunhu channel...");

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          resolve();
        });
      });
      this.server = null;
      logger.info("Yunhu webhook server stopped");
    }

    logger.info("Yunhu channel stopped");
  }

  /**
   * Handle HTTP request
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      // Only handle POST requests to the specified path
      if (req.method !== "POST" || req.url !== this.webhookPath) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      // Parse request body
      const body = await this.parseRequestBody(req);

      logger.debug(
        {
          url: req.url,
          method: req.method,
          contentType: req.headers["content-type"],
          bodyLength: body.length
        },
        "Received Yunhu webhook request"
      );

      // Validate JSON format
      if (!body) {
        res.writeHead(400);
        res.end("Bad Request: Empty body");
        return;
      }

      // Parse event VO
      const eventVo = JSON.parse(body) as YunhuEventVo;

      logger.debug(
        {
          eventId: eventVo.header?.eventId,
          eventType: eventVo.header?.eventType,
        },
        "Yunhu webhook event received"
      );

      // Handle event
      await this.handleWebhookEvent(eventVo);

      // Return success response
      res.writeHead(200);
      res.end(JSON.stringify({ code: 200, msg: "OK" }));
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
          url: req.url,
          method: req.method,
          headers: req.headers
        },
        "Error handling Yunhu webhook request"
      );

      res.writeHead(500);
      res.end(JSON.stringify({ code: 500, msg: "Internal Server Error" }));
    }
  }

  /**
   * Parse request body
   */
  private parseRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";

      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        resolve(body);
      });

      req.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * Handle received webhook event
   */
  private async handleWebhookEvent(eventVo: YunhuEventVo): Promise<void> {
    const { header, event } = eventVo;

    logger.debug(
      {
        hasHeader: !!header,
        hasEvent: !!event,
        header: header ? { eventType: header.eventType } : null
      },
      "Processing Yunhu webhook event"
    );

    // Route to different message handlers based on eventType
    if (!header) {
      logger.warn("Yunhu event has no header");
      return;
    }

    const eventType = header.eventType;

    // Normal message events (support both old and new event types)
    if ((eventType === "EventMessageReceiveNormal" || eventType === "message.receive.normal") && event.message) {
      await this.handleNormalMessage(event);
    }
    // Command message events
    else if ((eventType === "EventMessageReceiveInstruction" || eventType === "message.receive.instruction") && event.message) {
      await this.handleNormalMessage(event);
    }
    // New member joined group event
    else if (eventType === "EventGroupJoin" || eventType === "group.join") {
      logger.info(
        { groupId: event.groupId, userId: event.userId },
        "Yunhu group join event"
      );
    }
    // Member left group event
    else if (eventType === "EventGroupLeave" || eventType === "group.leave") {
      logger.info(
        { groupId: event.groupId, userId: event.userId },
        "Yunhu group leave event"
      );
    }
    // Bot followed event
    else if (eventType === "EventBotFollowed" || eventType === "bot.followed") {
      logger.info(
        { userId: event.userId, nickname: event.nickname },
        "Yunhu bot followed event"
      );
    }
    // Bot unfollowed event
    else if (eventType === "EventBotUnfollowed" || eventType === "bot.unfollowed") {
      logger.info(
        { userId: event.userId, nickname: event.nickname },
        "Yunhu bot unfollowed event"
      );
    }
    // Unknown event type
    else {
      logger.warn({ eventType }, "Unknown Yunhu event type");
    }
  }

  /**
   * Handle normal message event
   */
  private async handleNormalMessage(event: YunhuEventMessage): Promise<void> {
    const sender = event.sender;
    const chat = event.chat;
    const message = event.message;

    if (!sender || !chat || !message) {
      logger.warn("Missing required fields in Yunhu event message");
      return;
    }

    // Check sender permissions
    if (!this.isAllowed(sender.senderId)) {
      logger.debug({ senderId: sender.senderId }, "Yunhu message from unauthorized sender");
      return;
    }

    // Build message content
    const contentParts: string[] = [];
    const mediaPaths: string[] = [];

    // Extract content based on message type
    const { content, mediaUrl } = this.extractMessageContent(
      message.contentType,
      message.content
    );

    contentParts.push(content);

    // If there's media URL, download and save
    if (mediaUrl) {
      const downloadedPath = await this.downloadMedia(mediaUrl);
      if (downloadedPath) {
        mediaPaths.push(downloadedPath);
      }
    }

    const finalContent = contentParts.join("\n") || "[empty message]";

    logger.debug(
      { senderId: sender.senderId, content: finalContent.slice(0, 50) },
      "Yunhu message received"
    );

    // Build metadata
    const metadata: Record<string, unknown> = {
      messageId: message.msgId,
      chatType: chat.chatType,
      contentType: message.contentType,
      senderNickname: sender.senderNickname,
      senderUserLevel: sender.senderUserLevel,
      senderId: sender.senderId, // Add sender ID for reply recipient determination
    };

    // If group chat, add group info
    if (chat.chatType === YUNHU_CHAT_TYPE.GROUP) {
      metadata.groupId = chat.chatId;
      metadata.groupName = event.groupName;
    }

    // If command message, add command info
    if (message.commandId !== undefined) {
      metadata.commandId = message.commandId;
    }
    if (message.commandName) {
      metadata.commandName = message.commandName;
    }

    // Call handleMessage to forward to message bus
    // In private chat, chatId is the bot ID, we need it to identify the conversation
    // But when replying, we should use senderId as the recipient
    await this.handleMessage(
      sender.senderId,
      chat.chatId,
      finalContent,
      mediaPaths,
      metadata
    );
  }

  /**
   * Extract message content
   */
  private extractMessageContent(
    contentType: string,
    content: YunhuMessageContent
  ): { content: string; mediaUrl?: string } {
    switch (contentType) {
      case YUNHU_CONTENT_TYPE.TEXT:
      case YUNHU_CONTENT_TYPE.MARKDOWN:
      case YUNHU_CONTENT_TYPE.HTML:
        return {
          content: content.text || "",
        };

      case YUNHU_CONTENT_TYPE.IMAGE:
        return {
          content: content.imageName
            ? `[Image: ${content.imageName}]`
            : "[Image]",
          mediaUrl: content.imageUrl,
        };

      case YUNHU_CONTENT_TYPE.FILE:
        return {
          content: content.fileName
            ? `[File: ${content.fileName}${
                content.fileSize ? ` (${formatFileSize(content.fileSize)})` : ""
              }]`
            : "[File]",
          mediaUrl: content.fileUrl,
        };

      case YUNHU_CONTENT_TYPE.VIDEO:
        return {
          content: "[Video]",
          // Video URL needs to be extracted from message content
        };

      default:
        return {
          content: `[Unsupported message type: ${contentType}]`,
        };
    }
  }

  /**
   * Send message to Yunhu
   *
   * @param msg - Message to send
   */
  async send(msg: OutboundMessage): Promise<void> {
    if (!this._running) {
      logger.warn("Yunhu channel is not running");
      return;
    }

    const maxRetries = MAX_RETRIES;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.sendMessageInternal(msg);
        return; // Send successful, return directly
      } catch (error) {
        lastError = error as Error;
        logger.warn(
          {
            chatId: msg.chatId,
            attempt,
            maxRetries,
            error: lastError.message,
          },
          "Failed to send Yunhu message"
        );

        // If last attempt, throw error
        if (attempt === maxRetries) {
          throw lastError;
        }

        // Wait for some time before retry (exponential backoff)
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Theoretically won't reach here, but for type safety
    if (lastError) {
      throw lastError;
    }
  }

  /**
   * Internal send message method
   */
  private async sendMessageInternal(msg: OutboundMessage): Promise<void> {
    // Determine recipient type
    const { recvType, recvId } = this.parseRecvInfo(msg.chatId, msg.metadata);

    // Build send request
    const sendRequest = await this.buildSendRequest(recvType, recvId, msg);

    logger.debug(
      {
        recvId,
        recvType,
        contentType: sendRequest.contentType,
        content: msg.content.slice(0, 100),
      },
      "Sending Yunhu message"
    );

    // Call API to send message
    const response = await this.callApi<{ code: number; msg: string; data?: { msgId: string } }>(
      "/bot/send",
      "POST",
      sendRequest
    );

    // Check if response exists
    if (!response) {
      throw new Error("Yunhu API returned null response");
    }

    // Check response (Yunhu API success response: code=200 or msg="success")
    if (response.code !== API_SUCCESS_CODE && response.msg !== API_SUCCESS_MESSAGE) {
      throw new Error(`Yunhu API error: ${response.msg}`);
    }

    logger.info(
      { msgId: response.data?.msgId, recvId },
      "Yunhu message sent successfully"
    );
  }

  /**
   * Parse recipient information
   */
  private parseRecvInfo(
    chatId: string,
    metadata?: Record<string, unknown>
  ): { recvType: string; recvId: string } {
    // Check if group chat
    if (metadata?.chatType === YUNHU_CHAT_TYPE.GROUP) {
      return {
        recvType: YUNHU_RECV_TYPE.GROUP,
        recvId: chatId,
      };
    }

    // Private chat scenario: use sender ID as recipient
    // In Yunhu, when user sends message to bot, chatId is bot ID, senderId is user ID
    // When replying, should use senderId (i.e., senderId in metadata)
    if (metadata?.senderId) {
      logger.debug(
        { chatId, senderId: metadata.senderId, recvId: String(metadata.senderId) },
        "Using senderId as recvId for private message"
      );
      return {
        recvType: YUNHU_RECV_TYPE.USER,
        recvId: String(metadata.senderId),
      };
    }

    // Fallback (theoretically shouldn't reach here)
    logger.warn({ chatId, metadata }, "No senderId found in metadata, using chatId as fallback");
    return {
      recvType: YUNHU_RECV_TYPE.USER,
      recvId: chatId,
    };
  }

  /**
   * Build send request
   */
  private async buildSendRequest(
    recvType: string,
    recvId: string,
    msg: OutboundMessage
  ): Promise<{
    recvId: string;
    recvType: string;
    contentType: string;
    content: { text?: string; imageKey?: string; fileKey?: string; videoKey?: string };
  }> {
    // Check if media files exist
    const hasMedia = msg.media && msg.media.length > 0;

    if (hasMedia) {
      // Media message (image, file, video)
      const mediaFile = msg.media[0];
      const mediaType = this.getMediaTypeFromPath(mediaFile);

      if (!mediaType) {
        logger.warn({ path: mediaFile }, "Unknown media type, sending as text fallback");
        return this.buildTextRequest(recvType, recvId, msg.content);
      }

      // Upload media file
      logger.info({ path: mediaFile, mediaType }, "Uploading media");
      const key = await this.uploadMedia(mediaFile, mediaType);

      if (!key) {
        // Upload failed, fallback to text send
        logger.warn({ path: mediaFile }, "Upload failed, sending as text fallback");
        return this.buildTextRequest(recvType, recvId, msg.content);
      }

      // Build request based on type
      if (mediaType === "image") {
        return this.buildImageRequest(recvType, recvId, key);
      } else if (mediaType === "video") {
        return this.buildVideoRequest(recvType, recvId, key);
      } else {
        return this.buildFileRequest(recvType, recvId, key);
      }
    }

    // Check if Markdown or HTML
    if (msg.content.startsWith("```") || msg.content.includes("\n```")) {
      // Contains code blocks, use Markdown
      return this.buildMarkdownRequest(recvType, recvId, msg.content);
    }

    if (msg.content.startsWith("<") && msg.content.endsWith(">")) {
      // Looks like HTML, but Yunhu may not support all HTML tags
      // Send as plain text for now
      logger.debug("HTML detected, sending as plain text");
      return this.buildTextRequest(recvType, recvId, msg.content);
    }

    // Check if content contains Markdown syntax
    const hasMarkdown =
      msg.content.includes("**") ||
      msg.content.includes("*") ||
      msg.content.includes("#") ||
      msg.content.includes("```") ||
      msg.content.includes("[");

    if (hasMarkdown) {
      return this.buildMarkdownRequest(recvType, recvId, msg.content);
    }

    // Default to plain text
    return this.buildTextRequest(recvType, recvId, msg.content);
  }

  /**
   * Build text message request
   */
  private buildTextRequest(recvType: string, recvId: string, text: string): {
    recvId: string;
    recvType: string;
    contentType: string;
    content: { text: string };
  } {
    return {
      recvId,
      recvType,
      contentType: YUNHU_CONTENT_TYPE.TEXT,
      content: { text },
    };
  }

  /**
   * Build Markdown message request
   */
  private buildMarkdownRequest(recvType: string, recvId: string, text: string): {
    recvId: string;
    recvType: string;
    contentType: string;
    content: { text: string };
  } {
    return {
      recvId,
      recvType,
      contentType: YUNHU_CONTENT_TYPE.MARKDOWN,
      content: { text },
    };
  }

  /**
   * Build image message request
   */
  private buildImageRequest(
    recvType: string,
    recvId: string,
    imageKey: string
  ): {
    recvId: string;
    recvType: string;
    contentType: string;
    content: { imageKey: string };
  } {
    return {
      recvId,
      recvType,
      contentType: YUNHU_CONTENT_TYPE.IMAGE,
      content: { imageKey },
    };
  }

  /**
   * Build file message request
   */
  private buildFileRequest(
    recvType: string,
    recvId: string,
    fileKey: string
  ): {
    recvId: string;
    recvType: string;
    contentType: string;
    content: { fileKey: string };
  } {
    return {
      recvId,
      recvType,
      contentType: YUNHU_CONTENT_TYPE.FILE,
      content: { fileKey },
    };
  }

  /**
   * Build video message request
   */
  private buildVideoRequest(
    recvType: string,
    recvId: string,
    videoKey: string
  ): {
    recvId: string;
    recvType: string;
    contentType: string;
    content: { videoKey: string };
  } {
    return {
      recvId,
      recvType,
      contentType: YUNHU_CONTENT_TYPE.VIDEO,
      content: { videoKey },
    };
  }

  /**
   * Call Yunhu API
   *
   * @param endpoint - API endpoint
   * @param method - HTTP method
   * @param body - Request body (optional)
   * @returns API response
   */
  private async callApi<T = unknown>(
    endpoint: string,
    method: "GET" | "POST",
    body?: unknown
  ): Promise<T> {
    // Ensure API URL doesn't end with slash, and endpoint starts with slash
    const baseUrl = this.apiUrl.endsWith("/") ? this.apiUrl.slice(0, -1) : this.apiUrl;
    const fullUrl = `${baseUrl}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`;

    const url = new URL(fullUrl);
    url.searchParams.append("token", this.token);

    const options: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url.toString(), options);

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Download media file
   *
   * @param url - Media file URL
   * @returns Saved file path
   */
  private async downloadMedia(url: string): Promise<string | null> {
    try {
      logger.debug({ url }, "Downloading media from Yunhu");

      const response = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const ext = this.getExtensionFromUrl(url);

      // Generate filename (use hash to avoid conflicts)
      const filename = this.generateFilename(buffer, ext);
      const mediaDir = join(homedir(), ".miniclawd", "media");

      // Ensure directory exists
      if (!existsSync(mediaDir)) {
        mkdirSync(mediaDir, { recursive: true });
      }

      const filePath = join(mediaDir, filename);

      // Save file
      await Bun.write(filePath, buffer);

      logger.info({ filePath, size: buffer.byteLength }, "Media downloaded successfully");

      return filePath;
    } catch (error) {
      logger.error({ error, url }, "Failed to download media");
      return null;
    }
  }

  /**
   * Upload media file
   *
   * @param filePath - Local file path
   * @param mediaType - Media type (image/video/file)
   * @returns Returned key (imageKey/fileKey/videoKey)
   */
  private async uploadMedia(
    filePath: string,
    mediaType: "image" | "video" | "file"
  ): Promise<string | null> {
    try {
      // Check cache
      const fileHash = this.getFileHash(filePath);
      const cached = this.mediaCache.get(fileHash);

      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        logger.debug({ fileHash, key: cached.key }, "Using cached upload");
        return cached.key;
      }

      logger.debug({ filePath, mediaType }, "Uploading media to Yunhu");

      // Create FormData
      const formData = new FormData();

      // Add file
      const file = await fileFromPath(filePath);
      formData.append(mediaType, file);

      // Build upload URL
      const url = new URL(`/${mediaType}/upload`, this.apiUrl);
      url.searchParams.append("token", this.token);

      // Send upload request
      const response = await fetch(url.toString(), {
        method: "POST",
        body: formData as any,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
      }

      const result = (await response.json()) as YunhuApiResponse<{ key: string }>;

      if (result.code !== API_SUCCESS_CODE || !result.data?.key) {
        throw new Error(`Upload error: ${result.msg}`);
      }

      const key = result.data.key;

      // Cache result
      this.mediaCache.set(fileHash, { key, timestamp: Date.now() });

      logger.info({ key, mediaType }, "Media uploaded successfully");

      return key;
    } catch (error) {
      logger.error({ error, filePath }, "Failed to upload media");
      return null;
    }
  }

  /**
   * Extract file extension from URL
   */
  private getExtensionFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const extMatch = pathname.match(/\.[a-zA-Z0-9]+$/);
      return extMatch ? extMatch[0] : "";
    } catch {
      return "";
    }
  }

  /**
   * Generate unique filename
   */
  private generateFilename(buffer: ArrayBuffer, ext: string): string {
    // Use SHA256 hash to generate filename
    const hash = createHash("sha256").update(Buffer.from(buffer)).digest("hex");
    return `${hash.slice(0, 16)}${ext}`;
  }

  /**
   * Calculate file hash (for caching)
   */
  private getFileHash(filePath: string): string {
    try {
      const content = readFileSync(filePath);
      return createHash("sha256").update(content).digest("hex").slice(0, 16);
    } catch {
      return filePath;
    }
  }

  /**
   * Determine media type based on file extension
   */
  private getMediaTypeFromPath(filePath: string): "image" | "video" | "file" | null {
    const ext = filePath.split(".").pop()?.toLowerCase() || "";

    const imageExts = ["jpg", "jpeg", "png", "gif", "webp", "bmp"];
    const videoExts = ["mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v"];

    if (imageExts.includes(ext)) {
      return "image";
    } else if (videoExts.includes(ext)) {
      return "video";
    } else {
      return "file";
    }
  }
}

/**
 * Format file size
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}
