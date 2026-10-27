/** The messages a scripted turn acts on; any other finishes at once, echoing its prompt. */
export const TURN_SCRIPT = {
  /** Parks after its first words until the service stub answers its release route. */
  hold: 'hold',
  /** Throws as the Agent SDK does when it cannot start its subprocess. */
  refuse: 'refuse',
  /** Notes an assumption on steps n1 and n2 through the composer's own MCP server, echoing each result. */
  assume: 'assume',
} as const;

/** The service stub's routes a scripted turn calls: once as it starts, and where a held turn parks. */
export const SCRIPT_ROUTE = { started: '/started', release: '/release' } as const;
