import type { FreeEvent } from "../shared/free.js";
import { AppError } from "../shared/model.js";
import type { FreeSession } from "./free-session.js";
import { stableId } from "./entities.js";
export async function freeEvents(host: FreeSession, id: string, after: number) {
  let task = await host.task(id);
  if (after > (task.eventCursor ?? 0))
    throw new AppError(400, "invalid_cursor");
  for (const phase of ["resolve", "execute"] as const) {
    const field = phase === "resolve" ? "resolutionRun" : "executionRun";
    const stage = task[field];
    if (!stage?.runId) continue;
    if (stage.eventsComplete) continue;
    const response = await host.mochi.request<{
      events: {
        cursor: number;
        type: string;
        created_at: string;
        data: Record<string, unknown>;
      }[];
      next_cursor: number;
    }>(`/v1/runs/${stage.runId}/events?after=${stage.eventCursor ?? 0}`);
    if (
      response.events.length > 100 ||
      !Number.isSafeInteger(response.next_cursor)
    )
      throw new AppError(503, "invalid_event_response");
    for (let offset = 0; offset < response.events.length; offset += 50) {
      task = await host.task(id);
      const current = task[field]!;
      const records: FreeEvent[] = [];
      for (const event of response.events.slice(offset, offset + 50)) {
        if (event.cursor <= (current.eventCursor ?? 0)) continue;
        if (event.cursor !== (current.eventCursor ?? 0) + 1)
          throw new AppError(503, "invalid_event_response");
        task.eventCursor = (task.eventCursor ?? 0) + 1;
        current.eventCursor = event.cursor;
        records.push({
          id: stableId(`free:event:${id}:${phase}:${event.cursor}`),
          kind: "event",
          revision: "",
          createdAt: event.created_at,
          conversationId: task.conversationId,
          taskId: id,
          cursor: task.eventCursor,
          remoteCursor: event.cursor,
          phase,
          runId: stage.runId,
          event,
        });
      }
      if (records.length)
        await host.records.transaction("library", [
          { record: task, revision: task.revision },
          ...records.map((record) => ({ record, revision: null })),
        ]);
    }
    task = await host.task(id);
    if (
      response.events.length < 100 &&
      stage.status &&
      !["queued", "running"].includes(stage.status)
    ) {
      task = await host.change(id, (t) => {
        t[field]!.eventsComplete = true;
      });
    } else break;
  }
  const events = (
    await host.records.list<FreeEvent>("event", task.conversationId)
  )
    .filter((e) => e.taskId === id && e.cursor > after)
    .sort((a, b) => a.cursor - b.cursor)
    .slice(0, 100);
  return {
    events: events.map((e) => ({
      ...e.event,
      cursor: e.cursor,
      phase: e.phase,
      runId: e.runId,
    })),
    next_cursor: events.at(-1)?.cursor ?? after,
  };
}
