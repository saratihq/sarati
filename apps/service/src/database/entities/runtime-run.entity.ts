import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

export type RuntimeRunStatus = 'running' | 'waiting' | 'completed' | 'error' | 'cancelled';
export type RuntimeStepStatus = 'running' | 'completed' | 'error';
export type RuntimeStepKind =
  'action' | 'code' | 'delay' | 'waitForEvent' | 'agent' | 'callWorkflow' | 'if' | 'switch';
/**
 * What started the run (best-effort provenance for the runs panel); `mcp` = an agent invoked a
 * published workflow, `sub_workflow` = another workflow called it.
 */
export type RunSource = 'manual' | 'trigger' | 'webhook' | 'api' | 'review_test' | 'mcp' | 'sub_workflow';

/** One runtime run; `id` is the user-scoped run id (`<user_id>:<run_id>`) == the DBOS workflow id. */
@Entity('runtime_runs')
@Index('ix_runtime_runs_user_started', ['userId', 'startedAt'])
export class RuntimeRunEntity {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  id!: string;

  /** Client-facing run id (unscoped). */
  @Column({ name: 'run_id', type: 'varchar', length: 120 })
  runId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'plan_id', type: 'varchar', length: 200 })
  planId!: string;

  @Column({ type: 'json', nullable: true })
  plan!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 20, default: 'running' })
  status!: RuntimeRunStatus;

  @Column({ type: 'json', nullable: true })
  outputs!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  /** The workflow this run executed (manual from-ir / workflow-bound trigger fires). */
  @Column({ name: 'workflow_id', type: 'uuid', nullable: true })
  workflowId!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  source!: RunSource | null;

  /** The run that called this one; null for a top-level run. */
  @Column({ name: 'parent_run_id', type: 'varchar', length: 200, nullable: true })
  parentRunId!: string | null;

  /** The calling step's `step_key` in the parent run — what links the two in both directions. */
  @Column({ name: 'parent_step_key', type: 'varchar', length: 500, nullable: true })
  parentStepKey!: string | null;

  /** The review this run tested, when `source = 'review_test'`. */
  @Column({ name: 'review_id', type: 'uuid', nullable: true })
  reviewId!: string | null;

  /** Dry run (preview): this run fired no state-changing external call. */
  @Column({ name: 'dry_run', type: 'boolean', default: false })
  dryRun!: boolean;

  // ── Approval state, set while status = 'waiting' and cleared on resume ──
  @Column({ name: 'waiting_node_id', type: 'varchar', length: 200, nullable: true })
  waitingNodeId!: string | null;

  @Column({ name: 'waiting_topic', type: 'varchar', length: 200, nullable: true })
  waitingTopic!: string | null;

  @Column({ name: 'waiting_since', type: 'timestamptz', nullable: true })
  waitingSince!: Date | null;

  @Column({ name: 'waiting_timeout_at', type: 'timestamptz', nullable: true })
  waitingTimeoutAt!: Date | null;

  // Who resolved the wait — org-wide approvals mean this may differ from `user_id`.
  @Column({ name: 'decided_by', type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  /** Environment name at run time (null = Default) — a historical SNAPSHOT, never re-resolved. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  environment!: string | null;

  @Column({ name: 'environment_id', type: 'uuid', nullable: true })
  environmentId!: string | null;

  /** The exact version this run executed — null for inline-plan/raw-IR runs or a deleted version. */
  @Column({ name: 'workflow_version_id', type: 'uuid', nullable: true })
  workflowVersionId!: string | null;
}

/** One executed step (action/delay/waitForEvent); `step_key` is loop-iteration-unique. */
@Entity('runtime_run_steps')
@Unique('uq_runtime_run_steps_run_step', ['runId', 'stepKey'])
export class RuntimeRunStepEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** The scoped run id (runtime_runs.id). */
  @Column({ name: 'run_id', type: 'varchar', length: 200 })
  runId!: string;

  @Column({ name: 'step_key', type: 'varchar', length: 300 })
  stepKey!: string;

  @Column({ name: 'node_id', type: 'varchar', length: 200 })
  nodeId!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: RuntimeStepKind;

  @Column({ type: 'varchar', length: 20 })
  status!: RuntimeStepStatus;

  @Column({ type: 'json', nullable: true })
  output!: unknown;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** True pinning: this step replayed a pinned sample, so no side effect fired. */
  @Column({ type: 'boolean', default: false })
  pinned!: boolean;

  /** Continue-on-fail: this step errored but the run went on (with `status = 'error'`). */
  @Column({ type: 'boolean', default: false })
  continued!: boolean;

  /** Retry-on-fail: how many times the provider was called for this step. */
  @Column({ type: 'integer', default: 1 })
  attempts!: number;

  /** Non-fatal `{{ref}}`s that resolved to nothing at run time; null when none. */
  @Column({ type: 'json', nullable: true })
  warnings!: string[] | null;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;
}
