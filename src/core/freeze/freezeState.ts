// ported-from: core/freeze/FreezeState.kt

/**
 * Whether the mirror is frozen, plus a generation number so that work started for one freeze (the
 * background hierarchy capture) is dropped when the freeze was turned off or replaced in the meantime.
 */
export class FreezeState {
  private _frozen = false
  private generation = 0

  get frozen(): boolean {
    return this._frozen
  }

  /** Turns the freeze on and returns its generation; while already frozen it keeps the current one. */
  freeze(): number {
    if (!this._frozen) {
      this._frozen = true
      this.generation++
    }
    return this.generation
  }

  unfreeze(): void {
    this._frozen = false
    this.generation++
  }

  /** True while the freeze that returned [token] is still the active one. */
  isCurrent(token: number): boolean {
    return this._frozen && token === this.generation
  }
}
