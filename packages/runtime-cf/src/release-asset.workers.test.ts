import { uploadReleaseAsset } from "@fractalboxdev/flare-dispatch-github-app";
import { describe, expect, it } from "vitest";

describe("release asset upload in workerd", () => {
  it("preserves Content-Length while streaming from R2", async () => {
    const expected = new Uint8Array([1, 2, 3, 4]);
    let observedLength: string | null = null;
    let observedBytes: Uint8Array | undefined;
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(expected);
        controller.close();
      },
    });
    await uploadReleaseAsset({
      token: "test-token",
      repo: "owner/name",
      releaseId: 7,
      name: "build.tar.gz",
      contentType: "application/gzip",
      size: expected.length,
      content,
      fetchImpl: async (url, init) => {
        const request = new Request(url, init);
        observedLength = request.headers.get("content-length");
        observedBytes = new Uint8Array(await request.arrayBuffer());
        return Response.json(
          {
            id: 42,
            name: "build.tar.gz",
            size: expected.length,
            browser_download_url: "https://github.com/owner/name/releases/download/v1/build.tar.gz",
          },
          { status: 201 },
        );
      },
    });
    expect(observedLength).toBe(String(expected.length));
    expect(observedBytes).toEqual(expected);
  });
});
