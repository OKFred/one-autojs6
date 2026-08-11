import type { DeviceTaskRequest, TaskPriority } from "./protocol.js";

/** 带本机接收序号的待执行任务。 */
export interface QueuedDeviceTask {
  request: DeviceTaskRequest;
  sequence: number;
}

const PRIORITY_RANK: Record<TaskPriority, number> = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
};

/** 返回任务优先级的可比较数值。 */
export function priorityRank(priority: TaskPriority): number {
  return PRIORITY_RANK[priority];
}

/** 新任务是否满足显式抢占当前任务的条件。 */
export function canPreemptRunning(
  incoming: DeviceTaskRequest,
  running: DeviceTaskRequest,
): boolean {
  return (
    incoming.preemptRunning &&
    priorityRank(incoming.priority) >= priorityRank(running.priority)
  );
}

/** 按优先级降序、同级接收顺序升序插入任务。 */
export function insertQueuedTask(
  queue: QueuedDeviceTask[],
  incoming: QueuedDeviceTask,
): void {
  const index = queue.findIndex((queued) => {
    const rankDifference =
      priorityRank(incoming.request.priority) -
      priorityRank(queued.request.priority);
    return rankDifference > 0;
  });
  if (index < 0) queue.push(incoming);
  else queue.splice(index, 0, incoming);
}

/**
 * 为进入满队列的 HIGH 任务寻找淘汰目标。
 * 只淘汰更低优先级，并选择最低优先级中等待最久的一项。
 */
export function findHighPriorityEvictionIndex(
  queue: readonly QueuedDeviceTask[],
  incoming: DeviceTaskRequest,
): number {
  if (incoming.priority !== "HIGH") return -1;
  const lower = queue
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        priorityRank(entry.request.priority) < priorityRank(incoming.priority),
    )
    .sort((left, right) => {
      const priorityDifference =
        priorityRank(left.entry.request.priority) -
        priorityRank(right.entry.request.priority);
      return priorityDifference || left.entry.sequence - right.entry.sequence;
    });
  return lower[0]?.index ?? -1;
}
