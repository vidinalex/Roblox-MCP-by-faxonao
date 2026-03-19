local Players = game:GetService("Players")
local PPS = game:GetService("ProximityPromptService")
local RS = game:GetService("ReplicatedStorage")

local A = require(RS:WaitForChild("Aether"))
local X, UI, N, W, B

for _ = 1, 60 do
    X = A:LoadLibrary("AudioService")
    UI = A:LoadLibrary("UIService")
    N = A:LoadLibrary("NotificationService")
    W = A:LoadLibrary("WeaponConfig")
    B = A:LoadLibrary("BrainrotConfig")
    if X then
        break
    end
    task.wait(0.25)
end

if not X then
    return
end

if UI and not UI.__AudioWrapped then
    UI.__AudioWrapped = true
    local o = UI.Open
    local c = UI.Close

    if type(o) == "function" then
        function UI:Open(n, a)
            local r = { pcall(o, self, n, a) }
            if r[1] then
                X:PlayScreenOpen(n)
            else
                error(r[2], 2)
            end
            return select(2, table.unpack(r))
        end
    end

    if type(c) == "function" then
        function UI:Close(n, a)
            local r = { pcall(c, self, n, a) }
            if r[1] then
                X:PlayScreenClose(n)
            else
                error(r[2], 2)
            end
            return select(2, table.unpack(r))
        end
    end
end

if N and not N.__AudioWrapped then
    N.__AudioWrapped = true
    local f = N.Notify

    if type(f) == "function" then
        function N:Notify(a, b, c)
            local text = type(a) == "string" and a or (type(b) == "string" and b or "")
            if text ~= "" then
                local l = string.lower(text)
                if string.find(text, "Claimed ", 1, true) then
                    X:PlayLocal("Rewards.TimeClaim", { K = "claim" })
                elseif string.find(l, "rebirth successful", 1, true) then
                    X:PlayLocal("Rewards.RebirthSuccess", { K = "rebirth_ok" })
                elseif string.find(l, "rebirth failed", 1, true)
                    or string.find(l, "requirements not met", 1, true)
                then
                    X:PlayLocal("Rewards.RebirthFail", { K = "rebirth_fail" })
                else
                    X:PlayLocal("UI.Notification", { K = "notify" })
                end
            end
            return f(self, a, b, c)
        end
    end
end

local seen = {}

local function bindButton(b)
    if seen[b] or not b:IsA("GuiButton") then
        return
    end

    seen[b] = true
    b.MouseEnter:Connect(function()
        X:PlayLocal("UI.Hover", { K = "h:" .. b:GetFullName() })
    end)
    b.MouseButton1Down:Connect(function()
        X:PlayLocal("UI.Press", { K = "p:" .. b:GetFullName() })
    end)
    b.Activated:Connect(function()
        X:PlayLocal("UI.Click", { K = "c:" .. b:GetFullName() })
    end)
end

local p = Players.LocalPlayer
local g = p and (p:FindFirstChildOfClass("PlayerGui") or p:WaitForChild("PlayerGui", 10))

if g then
    for _, d in ipairs(g:GetDescendants()) do
        bindButton(d)
    end
    g.DescendantAdded:Connect(bindButton)
end

local proj = A:GetRemoteEvent(type(W) == "table" and W.RemoteProjectileEventName or "WeaponAttack:Projectile")
proj.OnClientEvent:Connect(function(t)
    local p = typeof(t) == "table" and (t.From or t.Position or t.Origin) or nil
    local w = typeof(t) == "table" and tostring(t.WeaponId or "") or ""
    if typeof(p) == "Vector3" then
        X:PlayWeaponAttack(w, { Position = p, K = "wp:" .. tostring(p) })
    end
end)

local money = A:GetRemoteEvent(type(B) == "table" and B.RemoteMoneyVfxEventName or "Brainrot:MoneyVfx")
money.OnClientEvent:Connect(function(t)
    local p = typeof(t) == "table" and t.Position or t
    if typeof(p) == "Vector3" then
        X:PlayLocal("Brainrot.Collect", { Position = p, K = "br:" .. tostring(p) })
    end
end)

PPS.PromptTriggered:Connect(function(prompt)
    if not prompt then
        return
    end

    local n = string.lower(prompt.Name)
    local a = string.lower(prompt.ActionText or "")
    if string.find(n, "brainrot", 1, true) and string.find(a, "place", 1, true) then
        X:PlayLocal("UI.Click", { K = "brainrot_place" })
    end
end)
