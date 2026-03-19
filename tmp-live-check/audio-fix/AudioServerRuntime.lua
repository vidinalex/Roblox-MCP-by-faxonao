local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Aether = require(ReplicatedStorage:WaitForChild("Aether"))
local Config = Aether:LoadLibrary("AudioConfig")
local DataManager = Aether:LoadLibrary("DataManager")

local AudioServerRuntime = {}

local initialized = false

local function normalizeSettings(input)
    local value = typeof(input) == "table" and input or {}

    return {
        Music = value.Music ~= false,
        SFX = value.SFX ~= false,
        Volume = math.clamp(tonumber(value.Volume) or 1, 0, 1),
        MusicVolume = math.clamp(tonumber(value.MusicVolume) or 1, 0, 1),
        SFXVolume = math.clamp(tonumber(value.SFXVolume) or 1, 0, 1)
    }
end

local function sanitizePatch(input)
    local result = {}
    if typeof(input) ~= "table" then
        return result
    end

    for _, key in ipairs({ "Music", "SFX", "Volume", "MusicVolume", "SFXVolume" }) do
        if input[key] ~= nil then
            result[key] = input[key]
        end
    end

    return result
end

local function resolvePlayers(target)
    if target == nil then
        return Players:GetPlayers()
    end
    if typeof(target) == "Instance" and target:IsA("Player") then
        return { target }
    end
    if typeof(target) == "table" then
        return target
    end
    return {}
end

function AudioServerRuntime:Init()
    if initialized then
        return
    end

    initialized = true

    local playRemote = Aether:GetRemoteEvent(Config.Remotes.Play)
    local getSettingsRemote = Aether:GetRemoteFunction(Config.Remotes.Get)
    local setSettingsRemote = Aether:GetRemoteEvent(Config.Remotes.Set)
    local changedRemote = Aether:GetRemoteEvent(Config.Remotes.Changed)

    getSettingsRemote.OnServerInvoke = function(player)
        return normalizeSettings(DataManager and DataManager:Get(player, "Settings") or Config.Defaults)
    end

    setSettingsRemote.OnServerEvent:Connect(function(player, value)
        for key, patchValue in pairs(sanitizePatch(value)) do
            if DataManager then
                DataManager:Set(player, "Settings." .. key, patchValue)
            end
        end
        changedRemote:FireClient(player, normalizeSettings(DataManager and DataManager:Get(player, "Settings") or Config.Defaults))
    end)

    AudioServerRuntime._play = playRemote
end

function AudioServerRuntime:PlayFor(target, cueId, options)
    for _, player in ipairs(resolvePlayers(target)) do
        if AudioServerRuntime._play then
            AudioServerRuntime._play:FireClient(player, {
                Cue = cueId,
                Options = options
            })
        end
    end
end

function AudioServerRuntime:PlayAll(cueId, options)
    self:PlayFor(nil, cueId, options)
end

function AudioServerRuntime:PlayPlace(placeId, cueId, options)
    local targets = {}
    local normalizedPlaceId = math.floor((tonumber(placeId) or 0) + 0.5)

    for _, player in ipairs(Players:GetPlayers()) do
        local value = player:GetAttribute("PlaceID")
        if typeof(value) == "number" and math.floor(value + 0.5) == normalizedPlaceId then
            targets[#targets + 1] = player
        end
    end

    self:PlayFor(targets, cueId, options)
end

return AudioServerRuntime
