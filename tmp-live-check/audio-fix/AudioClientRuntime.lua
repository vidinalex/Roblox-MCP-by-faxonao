local Debris = game:GetService("Debris")
local Players = game:GetService("Players")
local PPS = game:GetService("ProximityPromptService")
local RS = game:GetService("ReplicatedStorage")
local SS = game:GetService("SoundService")
local WS = game:GetService("Workspace")

local A = require(RS:WaitForChild("Aether"))
local C = A:LoadLibrary("AudioConfig")

local M = {}
local S = table.clone(C.Defaults)
local last = {}
local cur = nil
local lastMusic = nil
local inited = false
local token = 0
local hooksBound = false
local seenButtons = {}

local function cue(id)
    return C.Cues[id]
end

local function root(cat)
    return SS:FindFirstChild(C.Roots[cat])
end

local function norm(t)
    t = typeof(t) == "table" and t or {}
    S.Music = t.Music ~= false
    S.SFX = t.SFX ~= false
    S.Volume = math.clamp(tonumber(t.Volume) or 1, 0, 1)
    S.MusicVolume = math.clamp(tonumber(t.MusicVolume) or 1, 0, 1)
    S.SFXVolume = math.clamp(tonumber(t.SFXVolume) or 1, 0, 1)
end

local function byPath(cat, p)
    local r = root(cat)
    if not r or type(p) ~= "string" or p == "" then
        return
    end

    local x = r
    for s in string.gmatch(p, "[^/]+") do
        x = x and x:FindFirstChild(s)
    end

    if x and x:IsA("Sound") then
        return x
    end

    local n = string.match(p, "([^/]+)$")
    return n and r:FindFirstChild(n, true)
end

local function vol(c, b)
    local m = c.Cat == "Music" and S.MusicVolume or S.SFXVolume
    return math.max(0, (b or c.V or 0.5) * S.Volume * m)
end

local function ok(id, c, k)
    local enabled = (c.Cat == "Music" and S.Music or S.SFX)
        and S.Volume > 0
        and (c.Cat == "Music" and S.MusicVolume or S.SFXVolume) > 0

    if not enabled then
        return false
    end

    local t = os.clock()
    if t - (last[k or id] or 0) < (c.I or 0) then
        return false
    end

    last[k or id] = t
    return true
end

local function par(o)
    if typeof(o) ~= "table" then
        return SS
    end

    local p = o.Parent
    if typeof(p) == "Instance" then
        if p:IsA("Attachment") or p:IsA("BasePart") then
            return p
        end

        if p:IsA("Model") then
            return p.PrimaryPart or p:FindFirstChildWhichIsA("BasePart", true) or SS
        end
    end

    local v = o.Position
    if typeof(v) == "Vector3" then
        local q = Instance.new("Part")
        q.Name = "AudioEmitter"
        q.Transparency = 1
        q.Anchored = true
        q.CanCollide = false
        q.CanTouch = false
        q.CanQuery = false
        q.Size = Vector3.new(0.2, 0.2, 0.2)
        q.CFrame = CFrame.new(v)
        q.Parent = WS
        Debris:AddItem(q, 6)
        return q
    end

    return SS
end

local function play(id, o)
    local c = cue(id)
    if not c or not ok(id, c, typeof(o) == "table" and o.K or nil) then
        return
    end

    local t = byPath(c.Cat, c.Path)
    local s = t and t:Clone() or Instance.new("Sound")
    if not t then
        s.SoundId = c.Id or ""
    end

    if s.SoundId == "" then
        s:Destroy()
        return
    end

    s.Volume = vol(c, t and t.Volume or nil)
    s.RollOffMinDistance = c.N or 8
    s.RollOffMaxDistance = c.X or 50
    s.Looped = c.L == true
    s.Parent = (c.D or (typeof(o) == "table" and o.Is2D)) and SS or par(o)
    s:Play()
    Debris:AddItem(s, s.Looped and 8 or 4)
    return s
end

local function tracks()
    local r = root("Music")
    local t = {}

    if r then
        for _, d in ipairs(r:GetDescendants()) do
            if d:IsA("Sound") then
                t[#t + 1] = d
            end
        end
    end

    if #t == 0 then
        local c = cue("Music.Main")
        if c and c.Id then
            local s = Instance.new("Sound")
            s.SoundId = c.Id
            s.Name = "MusicMain"
            t[1] = s
        end
    end

    return t
end

local function music(k)
    task.spawn(function()
        while token == k do
            local c = cue("Music.Main")
            if not c or not S.Music or S.Volume <= 0 or S.MusicVolume <= 0 then
                if cur then
                    cur:Stop()
                    cur:Destroy()
                    cur = nil
                end
                task.wait(0.5)
            else
                local t = tracks()
                local pick = t[math.random(1, #t)]

                if #t > 1 then
                    for _, v in ipairs(t) do
                        if v.Name ~= lastMusic then
                            pick = v
                            break
                        end
                    end
                end

                if cur then
                    cur:Stop()
                    cur:Destroy()
                end

                local s = pick.Parent and pick:Clone() or pick
                s.Volume = vol(c, s.Volume)
                s.Looped = #t <= 1 and (c.L == true or s.Looped == true)
                s.Parent = SS
                cur = s
                lastMusic = s.Name
                s:Play()

                repeat
                    task.wait(0.25)
                until token ~= k or not s.Parent or (not s.IsPlaying and not s.Looped)

                if cur == s then
                    cur = nil
                end
                if s.Parent then
                    s:Destroy()
                end
                task.wait(0.15)
            end
        end
    end)
end

local function bindButton(button)
    if seenButtons[button] or not button:IsA("GuiButton") then
        return
    end

    seenButtons[button] = true
    button.MouseEnter:Connect(function()
        M:PlayLocal("UI.Hover", { K = "h:" .. button:GetFullName() })
    end)
    button.MouseButton1Down:Connect(function()
        M:PlayLocal("UI.Press", { K = "p:" .. button:GetFullName() })
    end)
    button.Activated:Connect(function()
        M:PlayLocal("UI.Click", { K = "c:" .. button:GetFullName() })
    end)
end

local function bindClientHooks()
    if hooksBound then
        return
    end

    hooksBound = true

    task.spawn(function()
        local UI = nil
        local NotificationService = nil
        local WeaponConfig = nil
        local BrainrotConfig = nil

        for _ = 1, 60 do
            UI = A:LoadLibrary("UIService")
            NotificationService = A:LoadLibrary("NotificationService")
            WeaponConfig = A:LoadLibrary("WeaponConfig")
            BrainrotConfig = A:LoadLibrary("BrainrotConfig")
            if UI or NotificationService or WeaponConfig or BrainrotConfig then
                break
            end
            task.wait(0.25)
        end

        if UI and not UI.__AudioWrapped then
            UI.__AudioWrapped = true
            local open = UI.Open
            local close = UI.Close

            if type(open) == "function" then
                function UI:Open(name, args)
                    local result = { pcall(open, self, name, args) }
                    if result[1] then
                        M:PlayScreenOpen(name)
                    else
                        error(result[2], 2)
                    end
                    return select(2, table.unpack(result))
                end
            end

            if type(close) == "function" then
                function UI:Close(name, args)
                    local result = { pcall(close, self, name, args) }
                    if result[1] then
                        M:PlayScreenClose(name)
                    else
                        error(result[2], 2)
                    end
                    return select(2, table.unpack(result))
                end
            end
        end

        if NotificationService and not NotificationService.__AudioWrapped then
            NotificationService.__AudioWrapped = true
            local notify = NotificationService.Notify

            if type(notify) == "function" then
                function NotificationService:Notify(a, b, c)
                    local text = type(a) == "string" and a or (type(b) == "string" and b or "")
                    if text ~= "" then
                        local lowerText = string.lower(text)
                        if string.find(text, "Claimed ", 1, true) then
                            M:PlayLocal("Rewards.TimeClaim", { K = "claim" })
                        elseif string.find(lowerText, "rebirth successful", 1, true) then
                            M:PlayLocal("Rewards.RebirthSuccess", { K = "rebirth_ok" })
                        elseif string.find(lowerText, "rebirth failed", 1, true)
                            or string.find(lowerText, "requirements not met", 1, true)
                        then
                            M:PlayLocal("Rewards.RebirthFail", { K = "rebirth_fail" })
                        else
                            M:PlayLocal("UI.Notification", { K = "notify" })
                        end
                    end
                    return notify(self, a, b, c)
                end
            end
        end

        local player = Players.LocalPlayer
        local playerGui = player and (player:FindFirstChildOfClass("PlayerGui") or player:WaitForChild("PlayerGui", 10))
        if playerGui then
            for _, descendant in ipairs(playerGui:GetDescendants()) do
                bindButton(descendant)
            end
            playerGui.DescendantAdded:Connect(bindButton)
        end

        local projectileRemote = A:GetRemoteEvent(type(WeaponConfig) == "table" and WeaponConfig.RemoteProjectileEventName or "WeaponAttack:Projectile")
        projectileRemote.OnClientEvent:Connect(function(payload)
            local position = typeof(payload) == "table" and (payload.From or payload.Position or payload.Origin) or nil
            local weaponId = typeof(payload) == "table" and tostring(payload.WeaponId or "") or ""
            if typeof(position) == "Vector3" then
                M:PlayWeaponAttack(weaponId, { Position = position, K = "wp:" .. tostring(position) })
            end
        end)

        local moneyRemote = A:GetRemoteEvent(type(BrainrotConfig) == "table" and BrainrotConfig.RemoteMoneyVfxEventName or "Brainrot:MoneyVfx")
        moneyRemote.OnClientEvent:Connect(function(payload)
            local position = typeof(payload) == "table" and payload.Position or payload
            if typeof(position) == "Vector3" then
                M:PlayLocal("Brainrot.Collect", { Position = position, K = "br:" .. tostring(position) })
            end
        end)

        PPS.PromptTriggered:Connect(function(prompt)
            if not prompt then
                return
            end

            local promptName = string.lower(prompt.Name)
            local actionText = string.lower(prompt.ActionText or "")
            if string.find(promptName, "brainrot", 1, true) and string.find(actionText, "place", 1, true) then
                M:PlayLocal("UI.Click", { K = "brainrot_place" })
            end
        end)
    end)
end

function M:Init()
    if inited then
        return
    end

    inited = true

    local p = A:GetRemoteEvent(C.Remotes.Play)
    local g = A:GetRemoteFunction(C.Remotes.Get)
    local s = A:GetRemoteEvent(C.Remotes.Set)
    local c = A:GetRemoteEvent(C.Remotes.Changed)

    local okGet, v = pcall(function()
        return g:InvokeServer()
    end)
    if okGet then
        norm(v)
    end

    c.OnClientEvent:Connect(norm)
    p.OnClientEvent:Connect(function(d)
        if typeof(d) == "table" and type(d.Cue) == "string" then
            play(d.Cue, d.Options)
        end
    end)

    token += 1
    music(token)
    M._set = s
    bindClientHooks()
end

function M:SetSettings(t)
    norm(table.freeze and table.clone(t) or t)
    if M._set then
        M._set:FireServer(t)
    end
end

function M:PlayLocal(id, o)
    return play(id, o)
end

function M:PlayScreenOpen(n)
    return play(C.Open[n] or "UI.ScreenOpen", { K = "open:" .. n, Is2D = true })
end

function M:PlayScreenClose(n)
    return play(C.Close[n] or "UI.ScreenClose", { K = "close:" .. n, Is2D = true })
end

function M:PlayWeaponAttack(w, o)
    return play(C.Weapon[w] or "Weapon.Attack.Generic", o)
end

return M
