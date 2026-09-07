import type { ReactNode } from "react";
export interface Reference {
  id: string;
  revision: string;
  label: string;
  text: string;
}
export interface ConversationItem {
  id: string;
  label: string;
}
export interface ModelItem {
  provider: string;
  id: string;
  name: string;
}
export interface Task {
  id: string;
  status: string;
  text: string;
  usage?: { cache_read: number } | null;
}
export interface EventPage {
  events: {
    cursor: number;
    type: string;
    data: { text?: string; status?: string };
  }[];
  next_cursor: number;
}
export interface HostAdapter {
  scopeKey: string;
  getContext(): Promise<{ label: string; references: Reference[] }>;
  listConversation(): Promise<ConversationItem[]>;
  openConversation(id?: string): Promise<ConversationItem>;
  history(id: string): Promise<{ role: string; content: string }[]>;
  models(): Promise<ModelItem[]>;
  tasks(id: string): Promise<Task[]>;
  resolveContext(
    conversationId: string,
    message: string,
    model: ModelItem,
    refs: Reference[],
    selection: string,
    feedback?: string,
  ): Promise<{ preview: string; request: unknown }>;
  submit(request: unknown): Promise<Task>;
  retry(id: string): Promise<Task>;
  cancel(id: string): Promise<Task>;
  resume(id: string): Promise<Task>;
  subscribe(id: string, after: number): Promise<EventPage>;
  renderContextActions(): ReactNode;
  renderResultActions(task: Task, refresh: () => void): ReactNode;
}
