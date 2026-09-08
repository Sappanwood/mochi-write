import type { Entity, Document, Filter, Page } from "../shared/model.js";
export interface Store {
  getVersion(
    id: string,
    projectId: string | null,
    version: number,
  ): Promise<Entity | undefined>;
  searchLibrary(filter: import("../shared/model.js").LibraryFilter): Promise<{
    items: import("../shared/model.js").LibraryEntry[];
    cursor?: string;
  }>;
  assetScopes(id: string): Promise<(string | null)[]>;
  get(id: string, projectId: string | null): Promise<Document | undefined>;
  list(filter: Filter): Promise<Page>;
  publishStory(story: Document): Promise<Document>;
  commit(entity: Entity, revision: string | null): Promise<Document>;
}
