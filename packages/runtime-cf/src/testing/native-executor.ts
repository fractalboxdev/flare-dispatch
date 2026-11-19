import type { NativeRequest } from "@fractalboxdev/flare-dispatch-core";

/** Fixed GitHub REST fixtures shared by tests that exercise actual D1/Workflow ownership. */
export const nativeExecutorResponse = (input: string | URL, request: Pick<NativeRequest, "repo" | "executor_ref" | "dispatch_ref">): Response | undefined => {
  const url = String(input), root = `https://api.github.com/repos/${request.repo}`;
  const tag = request.dispatch_ref.slice(10);
  if (url === `${root}/releases/tags/${encodeURIComponent(tag)}`) return Response.json({
    id: 42, url: `${root}/releases/42`, tag_name: tag, immutable: true, draft: false, published_at: "2026-10-01T00:00:00Z",
  });
  if (url === `${root}/git/ref/tags/${encodeURIComponent(tag)}`) return Response.json({
    ref: request.dispatch_ref, object: { type: "commit", sha: request.executor_ref },
  });
  if (url === `${root}/actions/workflows/native-windows.yml`) return Response.json({
    id: 7, path: ".github/workflows/native-windows.yml", state: "active",
  });
  if (url === `${root}/contents/.github/workflows/native-windows.yml`
    || url === `${root}/contents/.github/workflows/native-windows.yml?ref=${request.executor_ref}`) return Response.json({
    type: "file", path: ".github/workflows/native-windows.yml", sha: "b".repeat(40), size: 1024,
  });
};
