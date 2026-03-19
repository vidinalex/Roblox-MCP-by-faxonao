local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local Aether = require(ReplicatedStorage:WaitForChild("Aether"))

for _, name in ipairs({
    "AudioConfig",
    "AudioClientRuntime",
    "AudioServerRuntime",
    "AudioService"
}) do
    local module = ServerScriptService:FindFirstChild(name, true)
    if module and module:IsA("ModuleScript") then
        if not CollectionService:HasTag(module, "AE_Library") then
            CollectionService:AddTag(module, "AE_Library")
        end
        if not CollectionService:HasTag(module, "AE_ForceReplicate") then
            CollectionService:AddTag(module, "AE_ForceReplicate")
        end
    end
end

local audioService = Aether:LoadLibrary("AudioService")
if audioService and audioService.Init then
    audioService:Init()
end
