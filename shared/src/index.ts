export interface Envelope<T = unknown> {
  type: string;
  payload: T;
}

export interface AuthResponse {
  sessionId: string;
}

export interface ChatMessage {
  text: string;
  project?: string;
}

export interface ProjectInfo {
  name: string;
}
