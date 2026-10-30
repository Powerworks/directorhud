/**
 * EwmaBaseline — exponentially weighted moving average over observed window
 * MPS. Self-starting: the first sample seeds the baseline, so the engine can
 * arm after N warmup windows without a fixed global prior.
 */
export class EwmaBaseline {
  private current: number | null = null;

  readonly alpha: number;

  constructor(alpha: number) {
    if (!(alpha > 0 && alpha <= 1)) {
      throw new RangeError(`ewma alpha must be in (0,1], got ${alpha}`);
    }
    this.alpha = alpha;
  }

  update(sample: number): number {
    this.current =
      this.current === null
        ? sample
        : this.current + this.alpha * (sample - this.current);
    return this.current;
  }

  /** Current baseline; null before the first sample. */
  get(): number | null {
    return this.current;
  }

  reset(): void {
    this.current = null;
  }
}
