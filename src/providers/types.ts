export interface SendRequest {
  to: string;
  subject?: string;
  body: string;
}

export interface SendResult {
  /** thông tin sau khi gửi — worker ghi vào delivery event (VD link xem email Ethereal, message id) */
  info?: string;
}

export interface NotificationProvider {
  send(req: SendRequest): Promise<SendResult | void>;
}
