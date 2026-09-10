import type { Entity, Document, Filter, Page } from "../shared/model.js";
export interface DiscoveryEntry {
  asset_id: string;
  kind: import("../shared/free.js").AssetRef["kind"];
  story_id?: string;
  name: string;
  revision: string;
  version: number;
}
export interface Store {
  discoverAssets(
    filter: Filter,
  ): Promise<{ items: DiscoveryEntry[]; cursor?: string }>;
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
