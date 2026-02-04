/**
 * 云湖（YHChat）API 相关数据类型定义
 *
 */

/**
 * 事件头信息
 */
export interface YunhuEventHeader {
  /** 事件ID，全局唯一 */
  eventId: string;
  /** 事件产生的时间，毫秒13位时间戳 */
  eventTime: number;
  /** 事件类型 */
  eventType: string;
}

/**
 * 发送者信息
 */
export interface YunhuSender {
  /** 发送者ID，给用户回复消息需要该字段 */
  senderId: string;
  /** 发送者用户类型，取值：user */
  senderType: string;
  /** 发送者级别，取值：owner、administrator、member、unknown */
  senderUserLevel: string;
  /** 发送者昵称 */
  senderNickname: string;
}

/**
 * 聊天对象信息
 */
export interface YunhuChat {
  /** 聊天对象ID */
  chatId: string;
  /** 聊天对象类型，取值: bot、group */
  chatType: string;
}

/**
 * 消息内容
 */
export interface YunhuMessageContent {
  /** 当消息类型为text、markdown时，有值 */
  text?: string;
  /** 当消息类型为image时，有值 */
  imageUrl?: string;
  imageName?: string;
  /** 当消息类型为file时，有值 */
  fileName?: string;
  fileUrl?: string;
  /** 文件大小，单位Byte，字节 */
  fileSize?: number;
  /** 当消息类型为image、file时，有值 */
  etag?: string;
  /** 当消息类型为form（指令消息事件时，并且指令类型为自定义输入时）时，有值 */
  formJson?: Record<string, Record<string, unknown>>;
}

/**
 * 消息信息
 */
export interface YunhuMessage {
  /** 消息ID，全局唯一 */
  msgId: string;
  /** 引用消息时的父消息ID */
  parentId?: string;
  /** 消息发送时间，毫秒13位时间戳 */
  sendTime: number;
  /** 当前聊天的对象ID
   * - 单聊消息，chatId即对方用户ID
   * - 群聊消息，chatId即群ID
   * - 机器人消息，chatId即机器人ID
   */
  chatId: string;
  /** 当前聊天的对象类型
   * - group 群聊
   * - bot 机器人
   */
  chatType: string;
  /** 当前消息类型
   * - text 文本消息
   * - image 图片消息
   * - video 视频消息
   * - markdown Markdown消息
   * - file 文件消息
   * - html 网页消息
   * - post 帖子消息
   */
  contentType: string;
  /** 消息正文 */
  content: YunhuMessageContent;
  /** 指令ID，可用来区分用户发送的指令（已废弃） */
  instructionId?: number;
  /** 指令名称，可用来区分用户发送的指令（已废弃） */
  instructionName?: string;
  /** 指令ID，可用来区分用户发送的指令 */
  commandId?: number;
  /** 指令名称，可用来区分用户发送的指令 */
  commandName?: string;
}

/**
 * 事件内容（Event对象）
 * 包括事件的内容。注意：Event对象的结构会在不同的eventType下发生变化
 */
export interface YunhuEventMessage {
  /** 13位时间戳 */
  time?: number;
  /** 机器人ID */
  chatId?: string;
  /** bot */
  chatType?: string;
  /** 群ID */
  groupId?: string;
  /** 群昵称 */
  groupName?: string;
  /** 用户ID */
  userId?: string;
  /** 用户昵称 */
  nickname?: string;
  /** 头像 */
  avatarUrl?: string;
  /** JSON字符串，自行解析 */
  settingJson?: string;
  /** 发送者的信息 */
  sender?: YunhuSender;
  /** 聊天对象 */
  chat?: YunhuChat;
  /** 消息内容 */
  message?: YunhuMessage;
  /** 按钮上报事件来源ID */
  recvId?: string;
  /** 按钮上报事件来源类型：group、user */
  recvType?: string;
  /** 按钮上报事件：上报内容 */
  value?: string;
}

/**
 * 完整的事件消息对象
 */
export interface YunhuEventVo {
  /** 版本 */
  version: string;
  /** 事件头信息 */
  header: YunhuEventHeader;
  /** 事件内容 */
  event: YunhuEventMessage;
}

/**
 * 发送消息内容
 */
export interface YunhuSendMsgContent {
  /** 当消息类型为text、markdown时 */
  text?: string;
  /** 当消息类型为image时 */
  imageKey?: string;
  /** 当消息类型为file时，有值 */
  fileKey?: string;
  /** 当消息类型为video时，有值 */
  videoKey?: string;
  /** 消息中包括button（非必填） */
  buttons?: YunhuSendButton[];
}

/**
 * 发送按钮
 */
export interface YunhuSendButton {
  /** 按钮上的文字 */
  text: string;
  /**
   * 按钮动作类型
   * - 1: 跳转URL
   * - 2: 复制
   * - 3: 点击汇报
   */
  actionType: number;
  /** 当actionType为1时使用（非必填） */
  url?: string;
  /**
   * 当actionType为2时，该值会复制到剪贴板
   * 当actionType为3时，该值会发送给订阅端（非必填）
   */
  value?: string;
}

/**
 * 发送消息请求
 */
export interface YunhuSendMsgRequest {
  /**
   * 接收消息对象ID
   * - 用户: userId
   * - 群: groupId
   */
  recvId: string;
  /**
   * 接收对象类型
   * - 用户: user
   * - 群: group
   */
  recvType: string;
  /**
   * 消息类型，取值如下
   * - text
   * - image
   * - video
   * - file
   * - markdown
   * - html
   */
  contentType: string;
  content: YunhuSendMsgContent;
}

/**
 * 上传请求
 */
export interface YunhuUploadRequest {
  /** image/video/file */
  type: string;
  /** 本地文件路径 */
  filePath: string;
}

/**
 * 上传响应
 */
export interface YunhuUploadResponse {
  /** 成功：imageKey/fileKey/videoKey */
  key: string;
}

/**
 * 通用API响应
 */
export interface YunhuApiResponse<T = unknown> {
  /** 响应代码，200表示成功 */
  code: number;
  /** 响应消息 */
  msg: string;
  /** 响应数据 */
  data?: T;
}

/**
 * 发送消息响应
 */
export interface YunhuSendMsgResponse {
  /** 消息ID */
  msgId?: string;
}

/**
 * 常量：接收类型
 */
export const YUNHU_RECV_TYPE = {
  USER: "user",
  GROUP: "group",
} as const;

/**
 * 常量：内容类型
 */
export const YUNHU_CONTENT_TYPE = {
  TEXT: "text",
  IMAGE: "image",
  VIDEO: "video",
  FILE: "file",
  MARKDOWN: "markdown",
  HTML: "html",
} as const;

/**
 * 常量：按钮动作类型
 */
export const YUNHU_BUTTON_ACTION_TYPE = {
  JUMP_URL: 1,
  COPY: 2,
  REPORT: 3,
} as const;

/**
 * 常量：聊天类型
 */
export const YUNHU_CHAT_TYPE = {
  BOT: "bot",
  GROUP: "group",
} as const;

/**
 * 常量：发送者级别
 */
export const YUNHU_SENDER_LEVEL = {
  OWNER: "owner",
  ADMINISTRATOR: "administrator",
  MEMBER: "member",
  UNKNOWN: "unknown",
} as const;
