// ported-from: settings/ProjectViewState.kt
import { ProjectLayout } from '../core/project/projectLayout'

/** The part of vscode.Memento this needs (context.workspaceState), so the class has no vscode import and can be unit tested. */
export interface MementoLike {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): PromiseLike<void>
}

const KEY = 'mobileTestBench.projectView'

/** Per-workspace panel state (last device, layout), stored in the workspace state, not in the user settings. */
export class ProjectViewState {
  constructor(private readonly memento: MementoLike) {}

  layout(): ProjectLayout {
    return ProjectLayout.fromJSON(this.memento.get<unknown>(KEY))
  }

  async save(layout: ProjectLayout): Promise<void> {
    await this.memento.update(KEY, layout.normalized().toJSON())
  }
}
