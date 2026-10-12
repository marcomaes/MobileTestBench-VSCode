// No Kotlin counterpart: UiNode tree to the DTO the webview rebuilds it from.
import type { NodeDto } from '../protocol'
import { UiNode } from '../core/inspector/uiNode'

export function toDto(node: UiNode): NodeDto {
  return {
    platform: node.platform,
    rawType: node.rawType,
    attributes: { ...node.attributes },
    bounds: node.bounds ? { ...node.bounds } : undefined,
    children: node.children.map(toDto),
  }
}

export function fromDto(dto: NodeDto): UiNode {
  const node = new UiNode(dto.platform, dto.rawType, dto.attributes, dto.bounds)
  for (const child of dto.children) node.addChild(fromDto(child))
  return node
}
