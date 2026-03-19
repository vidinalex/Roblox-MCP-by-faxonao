local RunService = game:GetService("RunService")
local Aether = require(game:GetService("ReplicatedStorage"):WaitForChild("Aether"))

local runtimeName = RunService:IsClient() and "AudioClientRuntime" or "AudioServerRuntime"
local runtimeModule = Aether:LoadLibrary(runtimeName)

if not runtimeModule then
    error("[AudioService] Missing runtime.", 2)
end

return runtimeModule
