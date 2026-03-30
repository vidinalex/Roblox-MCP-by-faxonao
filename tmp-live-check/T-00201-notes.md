T-00201

Changed cached Studio script:
- .rbxmcp/cache/104217426530353/scripts/63427e881d576f1cd40b2c1144aab0b17455599a.lua

Behavior change:
- Rebirth now classifies placed weapons by growth progress using `PlantedAt + GrowthSeconds`.
- Immature front-yard plants are refunded to inventory as seeds instead of grown plants.
- Immature backyard plants are removed from the persisted backyard placement list and refunded as seeds.
- Mature backyard plants remain in the persisted backyard placement list to preserve existing rebirth behavior.
- Fallback place cleanup now destroys any place-owned planted instance, including active growth parts.

Verification status:
- Text-level checks passed locally.
- Roblox Studio manual scenario was not run from this environment.
