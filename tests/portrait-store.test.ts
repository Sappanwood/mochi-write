import { expect, it, vi } from "vitest";
import type { ContainerClient } from "@azure/storage-blob";
import { BlobPortraitStore } from "../src/server/portrait-store.js";
import { imageHash } from "../src/server/portraits.js";

it("uses immutable uploads and reconciles an existing identical object without overwriting", async () => {
  const data = Buffer.from("fixture"),
    id = imageHash(data);
  const uploadData = vi.fn().mockRejectedValue({ statusCode: 412 });
  const downloadToBuffer = vi.fn().mockResolvedValue(data);
  const blob = {
    uploadData,
    getProperties: vi
      .fn()
      .mockResolvedValue({ contentLength: data.length, etag: "v1" }),
    downloadToBuffer,
  };
  const container = { getBlockBlobClient: vi.fn().mockReturnValue(blob) };
  const store = new BlobPortraitStore(container as unknown as ContainerClient);
  await store.put(id, data);
  expect(uploadData).toHaveBeenCalledWith(
    data,
    expect.objectContaining({ conditions: { ifNoneMatch: "*" } }),
  );
  expect(downloadToBuffer).toHaveBeenCalledWith(0, data.length, {
    conditions: { ifMatch: "v1" },
  });
  expect(container.getBlockBlobClient).toHaveBeenCalledWith(`${id}.jpg`);
  downloadToBuffer.mockResolvedValue(Buffer.from("changed"));
  await expect(store.put(id, data)).rejects.toMatchObject({ statusCode: 409 });
  uploadData.mockRejectedValue({ statusCode: 403 });
  await expect(store.put(id, data)).rejects.toMatchObject({ statusCode: 403 });
  await expect(store.put("a".repeat(64), data)).rejects.toMatchObject({
    statusCode: 400,
  });
});

it("distinguishes missing storage objects from failures and bounds downloads", async () => {
  const blob = {
    getProperties: vi.fn().mockRejectedValue({ statusCode: 404 }),
    downloadToBuffer: vi.fn(),
  };
  const store = new BlobPortraitStore({
    getBlockBlobClient: () => blob,
  } as unknown as ContainerClient);
  expect(await store.get("a".repeat(64))).toBeUndefined();
  blob.getProperties.mockRejectedValue({ statusCode: 403 });
  await expect(store.get("a".repeat(64))).rejects.toMatchObject({
    statusCode: 403,
  });
  blob.getProperties.mockResolvedValue({ contentLength: 1024 * 1024 });
  await expect(store.get("a".repeat(64))).rejects.toMatchObject({
    statusCode: 503,
  });
  expect(blob.downloadToBuffer).not.toHaveBeenCalled();
  await expect(store.get("../private")).rejects.toThrow();
});
