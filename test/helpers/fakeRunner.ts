import { CommandResult, CommandRunner } from '../../src/core/exec/commandRunner'

/** Records every command and answers with a canned result. */
export class RecordingRunner extends CommandRunner {
  readonly commands: string[][] = []
  constructor(private readonly reply: (command: string[]) => CommandResult = () => new CommandResult(0, Buffer.alloc(0), '')) {
    super({})
  }
  override async run(command: string[]): Promise<CommandResult> {
    this.commands.push(command)
    return this.reply(command)
  }
}

export const ok = (stdout = '', stderr = ''): CommandResult => new CommandResult(0, Buffer.from(stdout), stderr)
export const fail = (stdout = '', stderr = '', exit = 1): CommandResult => new CommandResult(exit, Buffer.from(stdout), stderr)
