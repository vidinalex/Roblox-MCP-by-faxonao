local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Aether = require(ReplicatedStorage:WaitForChild("Aether"))

local audioService
for _ = 1, 60 do
    audioService = Aether:LoadLibrary("AudioService")
    if audioService and audioService.Init then
        audioService:Init()
        break
    end
    task.wait(0.25)
end
