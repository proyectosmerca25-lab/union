# UNIÓN — Architecture & Monorepo Root v1.0

UNIÓN es un sistema privado para coordinar el desarrollo y evolución de múltiples proyectos de software.

## Status: v1.0 APPROVED / FROZEN

- **Owner**: Omar
- **Architect / Coordinator / Auditor**: ChatGPT
- **Technical Executor**: Antigravity

---

## Monorepo Layout

```text
union/
├── union-core/     # Governance, State, Session & Orchestration Engine
├── union-web/      # Dashboard & Control Interface
└── shared/         # Shared Contracts, Types & Interfaces
```

---

## Canonical Sources of Truth (Fuentes de Verdad)

- **PostgreSQL**: Authoritative Operational State
- **Tencent Memory**: Project-Scoped Long-Term Semantic Memory
- **GitHub**: Implementation Truth & Evidence
- **Graphify**: Derived Structural Code Awareness
- **OpenAI**: Reasoning Engine (Brain)
- **UNIÓN Core**: Governance Gateway & Orchestration
- **Antigravity**: Technical Execution

---

## Workspace Packages

- [`@union/core`](./union-core/README.md)
- [`@union/web`](./union-web/README.md)
- [`@union/shared`](./shared/README.md)
