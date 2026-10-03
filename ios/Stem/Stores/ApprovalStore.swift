import Foundation
import Observation

/// Something an agent is waiting on the user for.
enum Approval: Identifiable, Hashable {
    case exec(ExecApprovalRequest)
    case mcp(McpAdminProposal)
    case instructions(InstructionsProposal)
    case skill(SkillProposal)

    var key: String {
        switch self {
        case .exec(let r): return "exec:\(r.id)"
        case .mcp(let p): return "mcp:\(p.id.idText)"
        case .instructions(let p): return "instructions:\(p.id.idText)"
        case .skill(let p): return "skill:\(p.id.idText)"
        }
    }

    var id: String { key }

    var threadId: String {
        switch self {
        case .exec(let r): return r.threadId
        case .mcp(let p): return p.threadId
        case .instructions(let p): return p.threadId
        case .skill(let p): return p.threadId
        }
    }
}

@MainActor @Observable
final class ApprovalStore {
    private(set) var queue: [Approval] = []
    var error: String?
    private let client: StemClient

    init(client: StemClient) { self.client = client }

    func attach(_ c: Connection) {
        _ = c.subscribe { [weak self] e in self?.on(e) }
    }

    func forThread(_ id: String?) -> [Approval] {
        guard let id else { return [] }
        return queue.filter { $0.threadId == id }
    }

    private func on(_ e: StreamEvent) {
        switch e {
        case .snapshot(_, let exec):
            // The snapshot is the whole truth for command approvals; the other
            // kinds aren't in it and stay until their resolved push arrives.
            queue.removeAll { if case .exec = $0 { return true }; return false }
            for r in exec { add(.exec(r)) }
        case .resync:
            break
        case .push(let channel, let payload):
            switch channel {
            case "exec:approvalRequest": if let r = try? payload.decode(ExecApprovalRequest.self) { add(.exec(r)) }
            case "mcp:adminApproval": if let r = try? payload.decode(McpAdminProposal.self) { add(.mcp(r)) }
            case "instructions:approvalRequest":
                if let r = try? payload.decode(InstructionsProposal.self) { add(.instructions(r)) }
            case "skills:approvalRequest": if let r = try? payload.decode(SkillProposal.self) { add(.skill(r)) }
            case "exec:approvalResolved": remove("exec", payload)
            case "mcp:adminApprovalResolved": remove("mcp", payload)
            case "instructions:approvalResolved": remove("instructions", payload)
            case "skills:approvalResolved": remove("skill", payload)
            default: break
            }
        }
    }

    private func add(_ a: Approval) {
        if !queue.contains(where: { $0.key == a.key }) { queue.append(a) }
    }

    private func remove(_ kind: String, _ payload: JSONValue) {
        guard let id = payload["id"] else { return }
        let key = "\(kind):\(id.idText)"
        queue.removeAll { $0.key == key }
    }

    private func drop(_ a: Approval) { queue.removeAll { $0.key == a.key } }

    func resolveExec(_ r: ExecApprovalRequest, _ decision: String) async {
        do {
            let ran = try await client.call("exec:resolveApproval", [.string(r.id), .string(decision)], as: Bool.self)
            drop(.exec(r))
            if !ran, decision != "deny" { error = "That request expired or was answered elsewhere — the command did not run." }
        } catch { self.error = error.localizedDescription }
    }

    func resolveMcp(_ p: McpAdminProposal, accept: Bool) async {
        await run(.mcp(p)) { try await self.client.run("mcp:adminDecision", [p.id, .bool(accept)]) }
    }

    func resolveSkill(_ p: SkillProposal, accept: Bool) async {
        let skill: JSONValue = ["name": .string(p.name), "description": .string(p.description), "body": .string(p.body)]
        await run(.skill(p)) { try await self.client.run("skills:resolveApproval", [p.id, .bool(accept), skill]) }
    }

    func resolveInstructions(_ p: InstructionsProposal, accept: Bool) async {
        await run(.instructions(p)) {
            let surface = p.suggestedSurface ?? "main"
            var text = ""
            if accept {
                let s = try await self.client.call("settings:get", as: ServerSettings.self)
                let current = surface == "quickChat" ? (s.customInstructions?.quickChat ?? "") : (s.customInstructions?.main ?? "")
                switch p.action {
                case "clear": text = ""
                case "replace": text = p.incomingText
                default: text = current.isEmpty ? p.incomingText : current + "\n" + p.incomingText
                }
            }
            try await self.client.run("instructions:resolveApproval", [p.id, .bool(accept), .string(surface), .string(text)])
        }
    }

    private func run(_ a: Approval, _ body: @escaping () async throws -> Void) async {
        do { try await body(); drop(a) } catch { self.error = error.localizedDescription }
    }
}
