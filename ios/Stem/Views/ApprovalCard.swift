import SwiftUI

/// An agent asking permission: run a command, change MCP servers, change
/// custom instructions, or save a skill.
struct ApprovalCard: View {
    @Environment(Session.self) private var session
    @Environment(AppModel.self) private var app
    let approval: Approval
    var showThreadLink = false
    @State private var working = false
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(title, systemImage: icon).font(.subheadline.weight(.semibold))
                Spacer()
                if showThreadLink {
                    Button("Open") { app.open(.thread(approval.threadId)) }
                        .font(.caption)
                        .buttonStyle(.borderless)
                }
            }
            content
            if let e = session.approvals.error {
                Text(e).font(.caption).foregroundStyle(.red)
            }
            actions
                .disabled(working)
        }
        .padding(12)
        .background(Color.yellow.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.yellow.opacity(0.4)))
    }

    private var title: String {
        switch approval {
        case .exec(let r): return r.deviceLabel.map { "Run a command on \($0)?" } ?? "Run a command?"
        case .mcp(let p): return p.action == "add" ? "Add an MCP server?" : "Remove an MCP server?"
        case .instructions(let p):
            return p.action == "clear" ? "Clear your custom instructions?" : p.action == "replace" ? "Replace your custom instructions?" : "Add to your custom instructions?"
        case .skill(let p): return p.isPatch ? "Update the skill “\(p.name)”?" : "Save the skill “\(p.name)”?"
        }
    }

    private var icon: String {
        switch approval {
        case .exec: return "terminal"
        case .mcp: return "puzzlepiece.extension"
        case .instructions: return "text.quote"
        case .skill: return "graduationcap"
        }
    }

    @ViewBuilder private var content: some View {
        switch approval {
        case .exec(let r):
            Text(r.command)
                .font(.system(.footnote, design: .monospaced))
                .lineLimit(expanded ? nil : 4)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                .onTapGesture { expanded.toggle() }
            Text("in \(r.cwd)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            if let reason = r.judgeReason, !reason.isEmpty {
                Label(reason, systemImage: r.judgeVerdict == "unsafe" ? "exclamationmark.triangle" : "questionmark.circle")
                    .font(.caption)
                    .foregroundStyle(r.judgeVerdict == "unsafe" ? .red : .secondary)
            }
        case .mcp(let p):
            Text(p.name ?? p.input?["name"]?.stringValue ?? "").font(.footnote.monospaced())
        case .instructions(let p):
            if p.action != "clear" {
                Text(p.incomingText).font(.footnote).lineLimit(expanded ? nil : 6).onTapGesture { expanded.toggle() }
            }
        case .skill(let p):
            Text(p.description).font(.footnote)
            if expanded { MarkdownView(p.body).font(.footnote) }
            Button(expanded ? "Hide skill" : "Show skill") { expanded.toggle() }.font(.caption).buttonStyle(.borderless)
        }
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: 8) {
            switch approval {
            case .exec(let r):
                Button("Allow once") { act { await session.approvals.resolveExec(r, "allowOnce") } }
                    .buttonStyle(.borderedProminent)
                if !r.prefixes.isEmpty {
                    Button("Always allow") { act { await session.approvals.resolveExec(r, "alwaysAllow") } }
                        .buttonStyle(.bordered)
                }
                Button("Deny", role: .destructive) { act { await session.approvals.resolveExec(r, "deny") } }
                    .buttonStyle(.bordered)
            case .mcp(let p):
                Button("Allow") { act { await session.approvals.resolveMcp(p, accept: true) } }.buttonStyle(.borderedProminent)
                Button("Deny", role: .destructive) { act { await session.approvals.resolveMcp(p, accept: false) } }.buttonStyle(.bordered)
            case .instructions(let p):
                Button("Allow") { act { await session.approvals.resolveInstructions(p, accept: true) } }.buttonStyle(.borderedProminent)
                Button("Deny", role: .destructive) { act { await session.approvals.resolveInstructions(p, accept: false) } }.buttonStyle(.bordered)
            case .skill(let p):
                Button("Save") { act { await session.approvals.resolveSkill(p, accept: true) } }.buttonStyle(.borderedProminent)
                Button("Discard", role: .destructive) { act { await session.approvals.resolveSkill(p, accept: false) } }.buttonStyle(.bordered)
            }
        }
        .controlSize(.small)
    }

    private func act(_ body: @escaping () async -> Void) {
        working = true
        Task {
            await body()
            working = false
        }
    }
}
