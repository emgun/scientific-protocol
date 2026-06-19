import { Storage } from "@google-cloud/storage";

export type GcsObjectLocator = {
  bucket: string;
  key: string;
};

export type GcsObjectWrite = GcsObjectLocator & {
  contentType: string;
  body?: string | Uint8Array;
  filePath?: string;
  metadata?: Record<string, string>;
};

export type GcsLikeClient = {
  saveObject(input: GcsObjectWrite): Promise<void>;
  openReadStream?(
    input: GcsObjectLocator,
  ): Promise<{ contentLength: number | null; stream: NodeJS.ReadableStream }>;
  readObject(input: GcsObjectLocator): Promise<Buffer>;
  objectExists(input: GcsObjectLocator): Promise<boolean>;
};

export function isGcsUrl(value: string): boolean {
  return value.startsWith("gs://");
}

export function parseGcsUrl(value: string): GcsObjectLocator {
  const match = value.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`invalid gcs path: ${value}`);
  }
  return { bucket: match[1], key: match[2] };
}

export function createDefaultGcsClient(): GcsLikeClient {
  const storage = new Storage();
  return {
    async saveObject(input) {
      const file = storage.bucket(input.bucket).file(input.key);
      if (input.filePath) {
        await storage.bucket(input.bucket).upload(input.filePath, {
          destination: input.key,
          metadata: {
            contentType: input.contentType,
            metadata: input.metadata,
          },
          resumable: false,
        });
        return;
      }

      const body =
        typeof input.body === "string" ? input.body : Buffer.from(input.body ?? new Uint8Array());
      await file.save(body, {
        contentType: input.contentType,
        metadata: input.metadata ? { metadata: input.metadata } : undefined,
        resumable: false,
      });
    },
    async openReadStream(input) {
      const file = storage.bucket(input.bucket).file(input.key);
      const [metadata] = await file.getMetadata();
      const size =
        typeof metadata.size === "string" && metadata.size.trim().length > 0
          ? Number(metadata.size)
          : null;
      return {
        contentLength: typeof size === "number" && Number.isFinite(size) ? size : null,
        stream: file.createReadStream(),
      };
    },
    async readObject(input) {
      const [buffer] = await storage.bucket(input.bucket).file(input.key).download();
      return buffer;
    },
    async objectExists(input) {
      const [exists] = await storage.bucket(input.bucket).file(input.key).exists();
      return exists;
    },
  };
}
