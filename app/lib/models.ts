export type Model = { id: string; name: string };

export function parseModelList(source: string): Model[] {
  return source.split(",").map((entry) => {
    const [id, ...nameParts] = entry.trim().split(":");
    return { id: id.trim(), name: nameParts.join(":").trim() };
  });
}
