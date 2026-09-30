import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, rawFetch, unwrap } from "../api/client";
import { useOrgId, useRole } from "../lib/org";
import { ErrorText } from "./ui";

/**
 * Attachments of one record: the existing files, plus (for roles that can write) an "Attach receipt"
 * button. No `capture` attribute: on a phone that would skip the chooser and open only the camera, and the
 * chooser already offers "Take Photo" alongside files, so an emailed PDF receipt can be picked too.
 */
export function Attachments({
  targetType,
  targetId,
  label = "Attach receipt",
}: {
  targetType: string;
  targetId: string;
  label?: string;
}) {
  const orgId = useOrgId();
  const { canWrite } = useRole();
  const qc = useQueryClient();
  const files = useQuery({
    queryKey: ["attachments", orgId, targetType, targetId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/attachments", {
          params: { path: { orgId }, query: { target_type: targetType, target_id: targetId } },
        }),
      ).then((r) => r.data),
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const form = new FormData();
      form.append("file", f);
      form.append("target_type", targetType);
      form.append("target_id", targetId);
      await rawFetch(`/api/v1/orgs/${orgId}/attachments`, { method: "POST", body: form });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attachments", orgId] }),
  });
  return (
    <div className="space-y-2 text-sm">
      {files.data && files.data.length > 0 && (
        <ul className="space-y-1" aria-label="Attachments">
          {files.data.map((f) => (
            <li key={f.id}>
              <a
                href={`/api/v1/orgs/${orgId}/attachments/${f.id}`}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {f.filename}
              </a>{" "}
              <span className="text-zinc-500">({Math.ceil(f.size_bytes / 1024)} KB)</span>
            </li>
          ))}
        </ul>
      )}
      {files.data?.length === 0 && <p className="text-zinc-500">No files.</p>}
      {canWrite && (
        <label className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 ring-1 ring-inset ring-zinc-300 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-500 hover:bg-zinc-50 touch:min-h-11 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800">
          {upload.isPending ? "Uploading…" : label}
          <input
            type="file"
            className="sr-only"
            accept="image/*,application/pdf"
            disabled={upload.isPending}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) upload.mutate(f);
            }}
          />
        </label>
      )}
      <ErrorText error={files.error ?? upload.error} />
    </div>
  );
}
