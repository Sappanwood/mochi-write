import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import type { AppConfig } from "./config.js";
import { AppError } from "../shared/model.js";
import { imageIdSchema } from "../shared/portrait.js";
import { imageHash, type PortraitStore } from "./portraits.js";

export class BlobPortraitStore implements PortraitStore {
  constructor(private readonly container: ContainerClient) {}
  private blob(id: string) {
    return this.container.getBlockBlobClient(`${imageIdSchema.parse(id)}.jpg`);
  }
  async put(id: string, data: Buffer) {
    if (imageHash(data) !== id) throw new AppError(400, "头像校验失败");
    try {
      await this.blob(id).uploadData(data, {
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "image/jpeg" },
      });
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        [409, 412].includes(Number(error.statusCode))
      ))
        throw error;
      const existing = await this.get(id);
      if (!existing || !existing.equals(data))
        throw new AppError(409, "头像存储冲突");
    }
  }
  async get(id: string) {
    try {
      const blob = this.blob(id),
        properties = await blob.getProperties();
      if (!properties.contentLength || properties.contentLength > 512 * 1024)
        throw new AppError(503, "头像大小无效");
      return await blob.downloadToBuffer(0, properties.contentLength, {
        conditions: { ifMatch: properties.etag },
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        error.statusCode === 404
      )
        return undefined;
      throw error;
    }
  }
}
export function configuredPortraits(config: AppConfig) {
  if (!config.portraitBlobEndpoint) return undefined;
  const client = new BlobServiceClient(
    config.portraitBlobEndpoint,
    new ManagedIdentityCredential({ clientId: config.managedIdentityClientId }),
  );
  return new BlobPortraitStore(
    client.getContainerClient(config.portraitBlobContainer),
  );
}
