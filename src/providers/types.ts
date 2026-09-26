export interface SendRequest {
  to: string;
  subject?: string;
  body: string;
}

export interface NotificationProvider {
  send(req: SendRequest): Promise<void>;
}
