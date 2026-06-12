# Codex Setup

```toml
model_provider = "stackbilt"
model = "stackbilt-auto"

[model_providers.stackbilt]
name = "StackBilt Local Gateway"
base_url = "http://localhost:8787/v1"
env_key = "STACKBILT_GATEWAY_KEY"
wire_api = "responses"
```

```bash
export STACKBILT_GATEWAY_KEY=local-dev-key
codex
```
