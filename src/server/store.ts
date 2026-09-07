import type { Entity, Document, Filter, Page } from "../shared/model.js";
export interface Store {
  get(id: string, projectId: string | null): Promise<Document | undefined>;
  list(filter: Filter): Promise<Page>;
  publishStory(story: Document): Promise<Document>;
  commit(entity: Entity, revision: string | null): Promise<Document>;
}
