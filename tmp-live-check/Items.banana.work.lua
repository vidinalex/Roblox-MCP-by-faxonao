local storage = game.ReplicatedStorage.Abilitys
local repStorage = game.ReplicatedStorage
local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")
local TweenService = game:GetService("TweenService")

local function emit(vfx)
	for i, thing in vfx:GetDescendants() do
		if thing:IsA("ParticleEmitter") then
			thing:Emit(1)
		end
	end
end

local Debris = game:GetService("Debris")
local RunService = game:GetService("RunService")
local SoundService = game:GetService("SoundService")
local MovementGuard
local BananaProjectileClass

if RunService:IsServer() then
	MovementGuard = require(game:GetService("ServerScriptService"):WaitForChild("AntiCheat"):WaitForChild("MovementGuard"))
	BananaProjectileClass = require(ServerStorage:WaitForChild("ServerClasses"):WaitForChild("BananaProjectile"))
end

local function allowBurstForPlayer(player: Player?, options)
	if MovementGuard and player then
		MovementGuard.AllowBurst(player, options)
	end
end

local function allowBurstForCharacter(character: Model?, options)
	if not MovementGuard or not character then
		return
	end

	local player = Players:GetPlayerFromCharacter(character)
	if player then
		MovementGuard.AllowBurst(player, options)
	end
end

local function markSafePlayer(player: Player?)
	if MovementGuard and player then
		MovementGuard.MarkSafe(player)
	end
end

local function playNamed3DSound(parent: Instance, soundName: string, life: number?)
	-- Looks for SoundService.<soundName> and clones it onto parent
	-- If you prefer sounds inside the Firework model, you can ignore this helper.
	local template = SoundService:FindFirstChild(soundName)
	if template and template:IsA("Sound") then
		local s = template:Clone()
		s.Parent = parent
		s:Play()
		Debris:AddItem(s, life or math.max(2, s.TimeLength + 0.25))
		return s
	end
	return nil
end

local function getWeaponSoundOrigin(char: Model): BasePart?
	local tool = char and char:FindFirstChildOfClass("Tool")
	if not tool then return nil end

	-- Prefer Handle if it exists
	local handle = tool:FindFirstChild("Handle")
	if handle and handle:IsA("BasePart") then
		return handle
	end

	-- Fallback: any BasePart in the tool
	return tool:FindFirstChildWhichIsA("BasePart", true)
end

local BANANA_PEEL_NAME = "BananaPeelTrap"
local bananaPeelsByCharacter: {[Model]: {[Instance]: true}} = {}
local bananaCleanupConnections: {[Model]: {RBXScriptConnection}} = {}

local function getBananaPeelParent(): Instance
	return workspace:FindFirstChild("Debris") or workspace
end

local function cleanupBananaConnections(char: Model)
	local connections = bananaCleanupConnections[char]
	if not connections then
		return
	end

	bananaCleanupConnections[char] = nil
	for _, connection in ipairs(connections) do
		connection:Disconnect()
	end
end

local function unregisterBananaPeel(char: Model, peel: Instance?)
	local peels = bananaPeelsByCharacter[char]
	if not peels or not peel then
		return
	end

	peels[peel] = nil
	if next(peels) == nil then
		bananaPeelsByCharacter[char] = nil
	end
end

local function cleanupBananaPeels(char: Model)
	local peels = bananaPeelsByCharacter[char]
	if peels then
		bananaPeelsByCharacter[char] = nil
		for peel in pairs(peels) do
			if peel and peel.Parent then
				peel:Destroy()
			end
		end
	end

	if char and char.Parent then
		char:SetAttribute("BananaCooldownActive", false)
		char:SetAttribute("BananaPeelsRemaining", nil)
	end
end

local function registerBananaPeel(char: Model, peel: Instance)
	local peels = bananaPeelsByCharacter[char]
	if not peels then
		peels = {}
		bananaPeelsByCharacter[char] = peels
	end

	peels[peel] = true
end

local function getBananaPeelTemplate(): Instance?
	return storage:FindFirstChild("BananaPeel")
end

local function getBananaPeelRoot(peel: Instance?): BasePart?
	if not peel then
		return nil
	end

	if peel:IsA("BasePart") then
		return peel
	end

	if peel:IsA("Model") then
		if peel.PrimaryPart then
			return peel.PrimaryPart
		end
		return peel:FindFirstChildWhichIsA("BasePart", true)
	end

	return peel:FindFirstChildWhichIsA("BasePart", true)
end

local function getBananaPeelParts(peel: Instance): {BasePart}
	local parts = {}
	if peel:IsA("BasePart") then
		table.insert(parts, peel)
		return parts
	end

	for _, descendant in ipairs(peel:GetDescendants()) do
		if descendant:IsA("BasePart") then
			table.insert(parts, descendant)
		end
	end

	return parts
end

local function pivotBananaPeel(peel: Instance, cframe: CFrame)
	if peel:IsA("Model") then
		peel:PivotTo(cframe)
	elseif peel:IsA("BasePart") then
		peel.CFrame = cframe
	end
end

local function setBananaPeelAnchored(peel: Instance, anchored: boolean)
	for _, part in ipairs(getBananaPeelParts(peel)) do
		part.Anchored = anchored
	end
end

local function setBananaPeelNetworkOwner(peel: Instance)
	for _, part in ipairs(getBananaPeelParts(peel)) do
		part:SetNetworkOwner(nil)
	end
end

local function ensureBananaCleanupHooks(char: Model)
	if bananaCleanupConnections[char] then
		return
	end

	local cleaned = false
	local function cleanup()
		if cleaned then
			return
		end
		cleaned = true
		cleanupBananaPeels(char)
		cleanupBananaConnections(char)
	end

	local connections = {}
	local humanoid = char:FindFirstChildOfClass("Humanoid")
	if humanoid then
		table.insert(connections, humanoid.Died:Connect(cleanup))
	end

	table.insert(connections, char.AncestryChanged:Connect(function(_, parent)
		if not parent then
			cleanup()
		end
	end))

	bananaCleanupConnections[char] = connections
end

local function isValidBananaTarget(ownerChar: Model, ownerPlayer: Player?, targetChar: Model?): boolean
	if not targetChar or targetChar == ownerChar then
		return false
	end

	local humanoid = targetChar:FindFirstChildOfClass("Humanoid")
	local root = targetChar:FindFirstChild("HumanoidRootPart")
	if not (humanoid and root and humanoid.Health > 0) then
		return false
	end

	if targetChar:GetAttribute("SafeZone") == true then
		return false
	end

	if targetChar:GetAttribute("Protected") then
		return false
	end

	if targetChar:GetAttribute("InDimension") then
		return false
	end

	if targetChar:HasTag("GodMode") then
		return false
	end

	if ownerPlayer and targetChar:GetAttribute("Ally") == ownerPlayer.Name then
		return false
	end

	return true
end

local function applyBananaSlip(targetChar: Model, peelPosition: Vector3, info): boolean
	local humanoid = targetChar:FindFirstChildOfClass("Humanoid")
	local root = targetChar:FindFirstChild("HumanoidRootPart")
	local ragdollValue = targetChar:FindFirstChild("IsRagdoll")
	if not (humanoid and root and ragdollValue and ragdollValue:IsA("BoolValue")) then
		return false
	end

	local knockbackDirection = root.Position - peelPosition
	knockbackDirection = Vector3.new(knockbackDirection.X, 0, knockbackDirection.Z)
	if knockbackDirection.Magnitude < 0.1 then
		local lookVector = root.CFrame.LookVector
		knockbackDirection = Vector3.new(lookVector.X, 0, lookVector.Z)
	end

	if knockbackDirection.Magnitude < 0.1 then
		knockbackDirection = Vector3.new(0, 0, -1)
	else
		knockbackDirection = knockbackDirection.Unit
	end

	targetChar:SetAttribute("KnockbackDir", knockbackDirection)
	targetChar:SetAttribute("KnockbackStrength", tonumber(info.SlipKnockbackStrength) or 35)
	ragdollValue.Value = true

	local ragdollDuration = tonumber(info.SlipRagdollDuration) or 1.25
	task.delay(ragdollDuration, function()
		if humanoid.Parent and humanoid.Health > 0 and ragdollValue.Parent then
			ragdollValue.Value = false
		end
	end)

	return true
end

local function resolveBananaThrowOrigin(char: Model, tool: Tool, direction: Vector3): Vector3
	local hrp = char:FindFirstChild("HumanoidRootPart")
	local origin = hrp and (hrp.Position + Vector3.new(0, 1.8, 0)) or Vector3.zero

	for _, descendant in ipairs(tool:GetDescendants()) do
		if descendant:IsA("Attachment") and descendant.Name == "ShootPoint" then
			local parentPart = descendant.Parent
			if parentPart and parentPart:IsA("BasePart") then
				return parentPart.CFrame:PointToWorldSpace(descendant.Position)
			end
			return descendant.WorldPosition
		end
	end

	local handle = tool:FindFirstChild("Handle")
	if handle and handle:IsA("BasePart") then
		return handle.Position + direction * 1.5 + Vector3.new(0, 0.35, 0)
	end

	return origin + direction * 1.5
end


local module = {
	--WEAPON
	["Stick"] = {
		Ability = "",
		Cooldown = 0,
		AbilityAnim = true
	},

	["Brick Stick"] = {
		Ability = "Brick",
		Cooldown = 2,
		Price = 70,
		Rarity = "Common",
		AbilityInfo = "Spawn a brick wall",
		AbilityAnim = false
	},

	["Dash Stick"] = {
		Ability = "Dash",
		Cooldown = 3.5,
		Price = 230,
		Rarity = "Common",
		AbilityInfo = "Air dash",
		AbilityAnim = false
	},

	["Spring Stick"] = {
		Ability = "Bouncy",
		Cooldown = 5,
		Price = 530,
		Rarity = "Common",
		AbilityInfo = "Jump super high",
		AbilityAnim = false
	},

	["Stone Stick"] = {
		Ability = "Boulder",
		Cooldown = 6,
		Price = 1050,
		Rarity = "Common",
		AbilityInfo = "Spawn a boulder",
		AbilityAnim = true
	},

	["Blinding Light"] = {
		Ability = "Flashbang",
		Cooldown = 8,
		Price = 1450,
		Rarity = "Common",
		AbilityInfo = "Blind everyone around you",
		AbilityAnim = false
	},



	["Speed Stick"] = {
		Ability = "Fast",
		Cooldown = 7,
		Price = 2500,
		Rarity = "Rare",
		AbilityInfo = "Super speed!",
		AbilityAnim = false
	},

	["Frost Rod"] = {
		Ability = "Ice",
		Cooldown = 8,
		Price = 3000,
		Rarity = "Rare",
		AbilityInfo = "Spawn Ice that freezes players",
		AbilityAnim = true
	},

	["Snow Gun"] = {
		Ability = "SnowGun",
		Cooldown = 3,
		SpecialRequirement = "Playtime30Once",
		Rarity = "Epic",
		AbilityInfo = "Launch a snowball that slows enemies for 5 seconds",
		AbilityAnim = false
	},

	["Swap Stick"] = {
		Ability = "Swap",
		Cooldown = 8,
		Price = 3500,
		Rarity = "Rare",
		AbilityInfo = "Swap position with the closest player",
		AbilityAnim = false
	},

	["Magnet Stick"] = {
		Ability = "Magnet",
		Cooldown = 14,
		Price = 6000,
		Rarity = "Rare",
		AbilityInfo = "Pull the closest player",
		AbilityAnim = false
	},

	["Grapling Stick"] = {
		Type = "SessionLocked",
		SessionKillsRequired = 30,
		Ability = "Grapple",
		Cooldown = 10,
		Rarity = "Rare",
		AbilityInfo = "Launch a hook and pull yourself to the target. Unlocked per session.",
		AbilityAnim = false,
		Range = 200,
		PullSpeed = 100,
		PullOffset = 3,
		RopeLifeTime = 0.4,
		HookTravelTime = 0.12,
		RopeWidth = 0.15
	},

	["Banana Stick"] = {
		Type = "SessionLocked",
		SessionKillsRequired = 5,
		Ability = "BananaPeel",
		Cooldown = 10,
		Rarity = "Rare",
		AbilityInfo = "Throw up to 3 banana peels; enemies trip and ragdoll",
		AbilityAnim = false,
		Charges = 3,
		PeelLifetime = 8,
		ArmDelay = 0.15,
		ThrowSpeed = 50,
		ThrowUpwardVelocity = 20,
		ProjectileRadius = 1.1,
		MaxFlightTime = 1.35,
		TrapRadius = 3.25,
		TrapPollInterval = 0.05,
		SlipRagdollDuration = 1.25,
		SlipKnockbackStrength = 35
	},

	["Ghost Stick"] = {
		Ability = "Invisible",
		Cooldown = 8,
		Price = 5000,
		Rarity = "Rare",
		AbilityInfo = "Turn invisible to other players",
		AbilityAnim = true
	},

	["Shockwave"] = {
		Ability = "Shockwave",
		Cooldown = 12,
		AbilityAnim = false,
		AbilityInfo = "Shockwave that flings nearby players",
		Price = 7500,
		Rarity = "Epic",
	},

	["Backstabber"] = {
		Ability = "Anime",
		Cooldown = 8,
		Price = 9600,
		Rarity = "Epic",
		AbilityInfo = "Teleport behind your enemy",
		AbilityAnim = false
	},

	["Slime Stick"] = {
		Ability = "Slime",
		Cooldown = 7,
		AbilityInfo = "Spawn A puddle of slime that slows down enemies",
		Price = 10000,
		Rarity = "Epic",
		AbilityAnim = false
	},

	["Bus Stick"] = {
		Ability = "Train",
		Cooldown = 8,
		Price = 16200,
		Rarity = "Epic",
		AbilityInfo = "Spawn train that go haha",
		AbilityAnim = false
	},

	["Train Stick"] = {
		Ability = "RailRush",
		Cooldown = 10,
		Price = 100000,
		Rarity = "Mythic",
		AbilityInfo = "Call in a runaway train that obliterates anything in its path",
		AbilityAnim = false
	},

	["Dimension Stick"] = {
		Ability = "Dimension",
		Duration = 5,
		VisibilityToOthers = 0, -- 0 = fully hidden to others, 1 = fully visible
		SpeedMultiplier = 1.5,
		Cooldown = 18,
		Price = 150000,
		Rarity = "Mythic",
		AbilityInfo = "Enter another dimension for 5 seconds (immune to being kebabed)",
		AbilityAnim = true
	},

	["Santa Stick"] = {
		Type = "SessionLocked",
		SessionKillsRequired = 100,
		SpawnCount = 3,
		Ability = "SantaRush",
		Cooldown = 12.5,
		Rarity = "Mythic",
		AbilityInfo = "Summon a wave of Santas that obliterate anything in their path",
		AbilityAnim = false
	},

	["Firework Stick"] = {
		Type = "SessionLocked",
		SessionKillsRequired = 200,

		Ability = "FireworkRain",
		Cooldown = 12,

		Rarity = "Mythic",
		AbilityInfo = "Launch a firework that detonates and wipes our everyone nearby",
		AbilityAnim = false,
	},

	["Rain Stick"] = { 
		Ability = "Rain",
		Cooldown = 10,
		Price = 13000,
		Rarity = "Epic",
		AbilityInfo = "Summon deadly sticks from the sky",
		AbilityAnim = false
	},

	["Plasma Spear"] = {
		Ability = "Shield",
		Cooldown = 10,
		Price = 18500,
		Rarity = "Legendary",
		AbilityInfo = "Create a forcefield that protects you",
		AbilityAnim = false
	},

	["Beam"] = {
		Ability = "Beam",
		Cooldown = 5,
		Price = 22500,
		Rarity = "Legendary",
		AbilityInfo = "Shoot a laser beam",
		AbilityAnim = false
	},

	["Thunderbolt"] = {
		Ability = "Smite",
		Cooldown = 15,
		Price = 30000,
		Rarity = "Legendary",
		AbilityInfo = "Lightning cloud that smites everybody around you",
		AbilityAnim = false
	},

	["Riptide"] = {
		Ability = "Tsunami",
		Cooldown = 12,
		Price = 40000,
		Rarity = "Legendary",
		AbilityInfo = "Spawn a tsuanmi on the map",
		AbilityAnim = false
	},

	["Mine Stick"] = {
		Ability = "Mine",
		Cooldown = 10,
		SpecialRequirement = "claimedDay7",
		AbilityInfo = "Place a mine that explodes people who step on it",
		AbilityAnim = false
	},

	["Elongated Stick"] = {
		Ability = "Extend",
		Cooldown = 10,
		Price = 0,
		AbilityInfo = "aa",
		AbilityAnim = false
	},

	["Necromancer"] = {
		Ability = "Summoner",
		Cooldown = 20,
		Price = 1250,
		Currency = "Stars",
		AbilityInfo = "Summon skeletons to kill enemies",
		AbilityAnim = false
	},

	["Rage Stick"] = {
		Ability = "Rage",
		Cooldown = 10,
		Price = 14500,
		Rarity = "Epic",
		AbilityInfo = "Charge forward in a rage, skewer everyone in your way",
		AbilityAnim = false
	},

	["Antigravity Stick"] = {
		Ability = "Antigravity",
		Cooldown = 14,
		Price = 200000,
		Rarity = "Mythic",
		AbilityInfo = "Pulse anti-gravity energy that makes nearby enemies float for 5 seconds",
		AbilityAnim = false,
		FloatDuration = 5,
		FloatRadius = 34,
		FloatHeight = 5
	},

	["Lucky Stick"] = {
		Ability = "Luck",
		Cooldown = 5,
		SpecialRequirement = "Spin",
		AbilityInfo = "Random ability or boost",
		AbilityAnim = false
	},

	["Lightsaber"] = {
		Ability = "Choke",
		Cooldown = 10,
		Price = 0,
		AbilityInfo = "summon eman above your head and get a random ability",
		AbilityAnim = false
	},

	["Tornado Stick"] = {
		Ability = "Whirlwind",
		Cooldown = 11,
		SpecialRequirement = "claimedDay7",
		AbilityInfo = "Summon a tornado that sucks in other players",
		AbilityAnim = true
	},

	["Prediction"] = {
		Ability = "Prediction",
		Cooldown = 5,
		Price = 35000,
		Rarity = "Legendary",
		AbilityInfo = "Deflect your opponents poke",
		AbilityAnim = false
	},

	--["Killstreak Stick"] = {
	--	Ability = "",
	--	Cooldown = 5,
	--	Price = 9e12,
	--	AbilityInfo = "Unlock different perks by killing players",
	--	AbilityAnim = false
	--},

	["Shock Stick"] = {
		Ability = "electrify",
		Cooldown = 12,
		Price = 16000,
		Rarity = "Epic",
		AbilityInfo = "Stun nearby players using an electric shock",
		AbilityAnim = false
	},

	["Shotgun Stick"] = {
		Ability = "Shotgun",
		Cooldown = 8,
		Price = 55000,
		Rarity = "Legendary",
		AbilityInfo = "Fire multiple projectiles in a spread",
		AbilityAnim = false
	},

	["Tempest Stick"] = {
		Ability = "ChainArrow",
		Cooldown = 11,
		Price = 70000,
		Rarity = "Mythic",
		AbilityInfo = "Launch a storm arrow that chains through up to 5 nearby enemies",
		AbilityAnim = false,
		ChainHits = 5,
		ChainRange = 24,
		ArrowRange = 170,
		ArrowRadius = 1.2,
		ChainDelay = 0.08
	},
	--[[
	["Smoke Stick"] = {
		Ability = "LVapeMan",
		Cooldown = 10,
		Price = 5500,
		Rarity = "Rare",
		AbilityInfo = "Create a cloud of smoke that you can see through",
		AbilityAnim = false
	},
	--]]

	--["eman is fat"] = {
	--Ability = "digger",
	--	Cooldown = 4,
	--	Price = 0,
	--	AbilityInfo = "black",
	--	AbilityAnim = false
	--},

	["Ninja Stick"] = {
		Ability = "Clone",
		Cooldown = 5,
		Price = 7000,
		Rarity = "Epic",
		AbilityInfo = "Clone yourself to confuse your enemy",
		AbilityAnim = false
	},

	--["Rewind Stick"] = {
	--Ability = "Rewind",
	--Cooldown = 10,
	--Price = 7000,
	--AbilityInfo = "Rewind 5 seconds back",
	--AbilityAnim = false
	--},

	--["Airstrike Stick"] = {
	--	Ability = "Airstrike",
	--	Cooldown = 10,
	--	Price = 12000,
	--	AbilityInfo = "Call in an airstrike",
	--	AbilityAnim = false
	--},

	["Sauce Stick"] = {
		Ability = "Sauce",
		Cooldown = 12,
		Price = 2800,
		AbilityInfo = "mustard",
		AbilityAnim = false
	},

	--GAMEPASS

	["Celestial Lance"] = {
		Ability = "UFO",
		Cooldown = 20,
		Price = 1250,
		Currency = "Stars",
		AbilityInfo = "Summon a UFO to abduct your enemies",
		AbilityAnim = false
	},


	["Atom Splitter"] = {
		Ability = "Nuke",
		Cooldown = 20,
		Price = 999999,
		Gamepass = 1198894964,
		AbilityInfo = "Nuke your location",
		AbilityAnim = false
	},

	-- SPECIAL

	["Death brick"] = {
		Ability = "killBrick",
		Cooldown = 0.1,
		Exclusive = true,
		AbilityAnim = true
	},

	["THAT'S A BUG"] = {
		Ability = "SHOKWAVE",
		Cooldown = 5,
		AbilityAnim = true,
		AbilityInfo = "bro what",
		Exclusive = true
	},

	["thejafar"] = {
		Ability = "Mine", -- WIP
		Cooldown = 4,
		AbilityAnim = true,
		AbilityInfo = "calling the gang",
		Exclusive = true
	},

	["The Stick"] = { -- Doesn't work :(
		Ability = "",
		Cooldown = 0,
		AbilityAnim = true,
		Exclusive = true
	},

	["Beans Stick"] = {
		Ability = "Beans",
		Cooldown = 0,
		AbilityAnim = false,
		Exclusive = false
	},

	["Lava Stick"] = {
		Ability = "LavaHit",
		Cooldown = 8,
		Price = 18000,
		Rarity = "Legendary",
		AbilityInfo = "Spawn a lava puddle that gradually kills players",
		AbilityAnim = true
	},


	--ABILITIES
	Abilities = {
		Brick = function(char, info,plr)
			local clone = storage.BrickWall:Clone()

			clone.Parent = workspace
			clone:PivotTo(char.HumanoidRootPart:GetPivot() * CFrame.new(0,0,-10))


			clone.Sound:Play()
			local tweenInfo = TweenInfo.new(
				0.3,                      -- Time (in seconds)
				Enum.EasingStyle.Quad,  -- Easing style
				Enum.EasingDirection.Out
			)

			clone.Size = Vector3.new(0,0,0)
			local tween = TweenService:Create(clone, tweenInfo, {Size = Vector3.new(8, 6, 1)})
			tween:Play()
			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			clone:Destroy()
			char:SetAttribute("abilityDebounce", false)
		end,

		Boulder = function(char, info,plr, look)
			local clone = storage.Boulder:Clone()

			clone.Parent = workspace
			clone:PivotTo(char.HumanoidRootPart:GetPivot() * CFrame.new(0,0,-5))
			clone.Name = char.Name

			local tweenInfo = TweenInfo.new(
				0.2,                      -- Time (in seconds)
				Enum.EasingStyle.Quad,  -- Easing style
				Enum.EasingDirection.Out
			)

			clone.Size = Vector3.new(0,0,0)
			local tween = TweenService:Create(clone, tweenInfo, {Size = Vector3.new(9, 9, 9)})
			tween:Play()

			clone:ApplyImpulse(look * 140)
			clone.Sound:Play()
			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			clone:Destroy()
			char:SetAttribute("abilityDebounce", false)
		end,

		Invisible = function(char, info,plr)
			local duration = 6
			if type(info.Duration) == "number" then
				duration = info.Duration
			end

			-- Config: `Invisibility` is treated as "how visible you are" (0 = fully invisible, 1 = fully visible)
			local visibility = 0
			if type(info.Invisibility) == "number" then
				visibility = math.clamp(info.Invisibility, 0, 1)
			end
			local invisibilityLtm = 1 - visibility

			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "Invisible")

			if RunService:IsServer() and char and plr then
				-- Attribute-based so late-joiners also see the effect and no remotes are required.
				local id = (char:GetAttribute("InvisibilityId") or 0) + 1
				char:SetAttribute("InvisibilityId", id)
				char:SetAttribute("InvisibleToOthers", true)
				char:SetAttribute("InvisibilityAmount", invisibilityLtm)
				if RunService:IsStudio() then
					warn(("[Invisible][Server] %s -> id=%d duration=%.2f visibility=%.2f ltm=%.2f"):format(plr.Name, id, duration, visibility, invisibilityLtm))
				end

				local invisRemote = repStorage:FindFirstChild("Remotes") and repStorage.Remotes:FindFirstChild("InvisibilityEffect")
				if invisRemote and invisRemote:IsA("RemoteEvent") then
					for _, other in ipairs(game:GetService("Players"):GetPlayers()) do
						if other ~= plr then
							invisRemote:FireClient(other, char, duration, invisibilityLtm, id)
						end
					end
					invisRemote:FireClient(plr, char, duration, 0.5, id)
				elseif RunService:IsStudio() then
					warn("[Invisible][Server] Missing Remotes.InvisibilityEffect RemoteEvent")
				end

				task.delay(duration, function()
					if not (char and char.Parent) then
						return
					end
					if (char:GetAttribute("InvisibilityId") or 0) ~= id then
						return
					end
					char:SetAttribute("InvisibleToOthers", false)
					char:SetAttribute("InvisibilityAmount", nil)
					if RunService:IsStudio() then
						warn(("[Invisible][Server] %s -> id=%d ended"):format(plr.Name, id))
					end
				end)
			end

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(duration)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce", false)
		end,

		Dimension = function(char: Model, info, plr: Player)
			local duration = 5
			if type(info.Duration) == "number" then
				duration = info.Duration
			end
			local speedMultiplier = tonumber(info.SpeedMultiplier) or 1
			local visibilityToOthers = 0
			if type(info.VisibilityToOthers) == "number" then
				visibilityToOthers = math.clamp(info.VisibilityToOthers, 0, 1)
			end
			local invisibilityToOthersLtm = 1 - visibilityToOthers

			if RunService:IsServer() and char and char.Parent then
				char:SetAttribute("InDimension", true)
				local humanoid = char:FindFirstChildOfClass("Humanoid")
				local originalWalkSpeed = humanoid and humanoid.WalkSpeed

				if humanoid and speedMultiplier > 0 and speedMultiplier ~= 1 then
					humanoid.WalkSpeed = originalWalkSpeed * speedMultiplier
				end

				do
					local torso = char:FindFirstChild("UpperTorso") or char:FindFirstChild("Torso")
					local darkAuraTemplate = repStorage:FindFirstChild("Abilitys")
						and repStorage.Abilitys:FindFirstChild("DarkAura")

					if torso and torso:IsA("BasePart") and darkAuraTemplate then
						local attach = Instance.new("Attachment")
						attach.Name = "DimensionDarkAuraAttachment"
						attach.Parent = torso
						Debris:AddItem(attach, duration)

						local clone = darkAuraTemplate:Clone()
						local function attachVfxInstance(inst: Instance)
							if inst:IsA("ParticleEmitter") or inst:IsA("Beam") or inst:IsA("Trail") or inst:IsA("PointLight") then
								inst.Parent = attach
								Debris:AddItem(inst, duration)
							end
						end

						attachVfxInstance(clone)
						if clone.Parent == nil then
							for _, inst in ipairs(clone:GetDescendants()) do
								attachVfxInstance(inst)
							end
							clone:Destroy()
						end
					end
				end

				-- Hide the dimension-walker from other players (visual only)
				do
					local invisRemote = repStorage:FindFirstChild("Remotes") and repStorage.Remotes:FindFirstChild("InvisibilityEffect")
					local invisId = (char:GetAttribute("InvisibilityId") or 0) + 1
					char:SetAttribute("InvisibilityId", invisId)
					char:SetAttribute("InvisibleToOthers", true)
					char:SetAttribute("InvisibilityAmount", invisibilityToOthersLtm)

					if invisRemote and invisRemote:IsA("RemoteEvent") and plr then
						local fired = 0
						for _, other in ipairs(game:GetService("Players"):GetPlayers()) do
							if other ~= plr then
								invisRemote:FireClient(other, char, duration, invisibilityToOthersLtm, invisId)
								fired += 1
							end
						end
						if RunService:IsStudio() then
							warn(("[Dimension][Server] %s hidden to %d clients (ltm=%.2f, id=%d)"):format(char.Name, fired, invisibilityToOthersLtm, invisId))
						end
					elseif RunService:IsStudio() then
						warn("[Dimension][Server] Missing Remotes.InvisibilityEffect RemoteEvent")
					end

					task.delay(duration, function()
						if not (char and char.Parent) then
							return
						end
						if (char:GetAttribute("InvisibilityId") or 0) ~= invisId then
							return
						end
						char:SetAttribute("InvisibleToOthers", false)
						char:SetAttribute("InvisibilityAmount", nil)
					end)
				end

				local remotes = repStorage:FindFirstChild("Remotes")
				if remotes then
					local dimensionEffect = remotes:FindFirstChild("DimensionEffect")
					if not dimensionEffect then
						dimensionEffect = Instance.new("RemoteEvent")
						dimensionEffect.Name = "DimensionEffect"
						dimensionEffect.Parent = remotes
					end
					if plr then
						dimensionEffect:FireClient(plr, duration)
					end
				end

				task.delay(duration, function()
					if char and char.Parent then
						char:SetAttribute("InDimension", false)

						local currentHumanoid = char:FindFirstChildOfClass("Humanoid")
						if currentHumanoid and originalWalkSpeed and speedMultiplier > 0 and speedMultiplier ~= 1 then
							currentHumanoid.WalkSpeed = originalWalkSpeed
						end
					end
				end)
			end

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce", false)
		end,

		Fast = function(char,info,plr)
			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "SpeedBoost")
			local A0 = game.ReplicatedStorage.VFX.Part.A01:Clone()
			local A1 =  game.ReplicatedStorage.VFX.Part.A11:Clone()
			local trail =  A0.Trail
			trail.Attachment0 = A0
			trail.Attachment1 = A1

			A0.Parent = char["Left Arm"]
			A1.Parent = char["Left Arm"]


			local A02 = game.ReplicatedStorage.VFX.Part.A01:Clone()
			local A12 =  game.ReplicatedStorage.VFX.Part.A11:Clone()
			local trail2 =  A02.Trail
			trail2.Attachment0 = A02
			trail2.Attachment1 = A12

			A02.Parent = char["Right Arm"]
			A12.Parent = char["Right Arm"]

			local speed = char.Humanoid.WalkSpeed
			char.Humanoid.WalkSpeed *= 1.9
			task.wait(3)
			A02:Destroy()
			A12:Destroy()
			A0:Destroy()
			A1:Destroy()
			char.Humanoid.WalkSpeed = speed

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce", false)
		end,


		Dash = function(char,info,plr)
			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "Dash")
			local root = char:FindFirstChild("HumanoidRootPart")
			local hum = char:FindFirstChild("Humanoid")
			allowBurstForPlayer(plr, {
				kind = "dash",
				duration = 0.75,
				maxDistance = 70,
				allowVertical = true,
				maxHorizontalSpeed = 140,
			})
			--adding dash trail
			local A0 = game.ReplicatedStorage.VFX.Part.A0:Clone()
			local A1 =  game.ReplicatedStorage.VFX.Part.A1:Clone()
			for i, trail in A0:GetChildren() do
				trail.Attachment0 = A0
				trail.Attachment1 = A1
			end

			A0.Parent = root
			A1.Parent = root

			local bv = Instance.new("BodyVelocity")
			local moved = hum.MoveDirection
			print(moved)
			if moved.Magnitude == 0 then
				bv.Velocity = root.CFrame.LookVector * 60
			else
				bv.Velocity = moved.Unit * 60
			end
			bv.MaxForce = Vector3.new(1e5, 0, 1e5)
			bv.Parent = root

			task.delay(0.5, function()
				A0:Destroy()
				A1:Destroy()
			end)
			task.delay(0.25, function()
				if bv then
					bv:Destroy()
				end
				markSafePlayer(plr)
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)

			char:SetAttribute("abilityDebounce", false)
		end,

		Bouncy = function(char,info,plr)
			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "Spring")
			local root = char:FindFirstChild("HumanoidRootPart")
			allowBurstForPlayer(plr, {
				kind = "jump_boost",
				duration = 0.5,
				maxDistance = 45,
				allowVertical = true,
				maxHorizontalSpeed = 40,
			})
			local bv = Instance.new("BodyVelocity")
			bv.Velocity = Vector3.new(0, 100, 0)
			bv.MaxForce = Vector3.new(0, 1e10, 0)
			bv.P = 1e10
			bv.Name = "JumpBoost"
			bv.Parent = root

			task.delay(0.25, function()
				if bv then
					bv:Destroy()
				end
			end)
			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		Ice = function(char,info,plr)
			local debounce = false
			local hum = char.Humanoid
			local tweeninfo = TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)



			local goal = {}
			goal.Size = Vector3.new(0.2,30,30)
			local goal2 = {}
			goal2.Size = Vector3.new(8.4, 30, 30)
			local ice = storage.Ice:Clone()
			local hitbox = ice.Hitbox:Clone()
			local tween = TweenService:Create(ice,tweeninfo,goal)
			local tween0 = TweenService:Create(hitbox,tweeninfo,goal2)
			hitbox.Parent = ice
			ice.Parent = game.Workspace
			hitbox.Anchored = true
			hitbox.CanCollide = false
			local offset = Vector3.new(0,3.5,0)
			ice.Size = Vector3.new(0,0,0)
			hitbox.Size = Vector3.new(0,0,0)
			ice.Position = char:GetPivot().Position - offset
			hitbox.Position = ice:GetPivot().Position
			tween:Play()
			tween0:Play()

			ice.Sound:Play()


			hitbox.Touched:Connect(function(hit)
				local enemy = hit.Parent
				local enemyPlr = game.Players:GetPlayerFromCharacter(enemy)
				--if debounce == true then return end
				if enemy:FindFirstChild("Humanoid") and enemy.Name ~= plr.Name then
					--debounce = true
					--for i, part in enemy:GetChildren() do
					--	if part:IsA("BasePart") then
					--	part.Anchored = true
					--		task.delay(3, function()
					--			part.Anchored = false
					--		end)
					--		end
					--end
					enemy.Humanoid.WalkSpeed = 0
					enemy.Humanoid.UseJumpPower = true
					enemy.Humanoid.JumpPower = 0
					--debounce = false
					task.wait(0.1)
					if not enemy:FindFirstChild("IceBlock") then
						local clone = game.ReplicatedStorage.Abilitys.IceBlock:Clone()
						clone.Parent = enemy
						clone.Position = enemy.HumanoidRootPart.Position
						game.Debris:AddItem(clone, 3) 
					end

					task.wait(2)
					enemy.Humanoid.WalkSpeed = enemyPlr:GetAttribute("Speed")
					enemy.Humanoid.JumpPower = 50

				end
			end)

			task.delay(1, function()
				local goal = {}
				goal.Size = Vector3.new(0,0,0)
				local goal2 = {}
				goal2.Size = Vector3.new(0,0,0)
				local tween = TweenService:Create(ice,tweeninfo,goal)
				local tween0 = TweenService:Create(hitbox,tweeninfo,goal2)
				tween:Play()
				tween0:Play()
				tween.Completed:Wait()
				ice:Destroy()
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		LavaHit = function(char,info,plr)
			local debounce = {}
			local hum = char.Humanoid
			local tweeninfo = TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)



			local goal = {}
			goal.Size = Vector3.new(0.2,30,30) * 0.7
			local goal2 = {}
			goal2.Size = Vector3.new(8.4, 30, 30) * 0.7
			local lava = storage.Lava:Clone()
			local hitbox = lava.Hitbox:Clone()
			local tween = TweenService:Create(lava,tweeninfo,goal)
			local tween0 = TweenService:Create(hitbox,tweeninfo,goal2)
			hitbox.Parent = lava
			lava.Parent = game.Workspace
			hitbox.Anchored = true
			hitbox.CanCollide = false
			local offset = Vector3.new(0,3.5,0)
			lava.Size = Vector3.new(0,0,0)
			hitbox.Size = Vector3.new(0,0,0)
			lava.Position = char:GetPivot().Position - offset
			hitbox.Position = lava:GetPivot().Position
			tween:Play()
			tween0:Play()

			--lava.Sound:Play()


			hitbox.Touched:Connect(function(hit)
				local enemy = hit.Parent
				local enemyPlr = game.Players:GetPlayerFromCharacter(enemy)
				--if debounce == true then return end
				if enemy:FindFirstChild("Humanoid") and enemy.Name ~= plr.Name then
					--debounce = true
					--for i, part in enemy:GetChildren() do
					--	if part:IsA("BasePart") then
					--	part.Anchored = true
					--		task.delay(3, function()
					--			part.Anchored = false
					--		end)
					--		end
					--end
					--debounce = false

					if debounce[enemy] then
						return
					end

					debounce[enemy] = true

					local humanoid: Humanoid = enemy:FindFirstChild("Humanoid")
					humanoid:TakeDamage(35)
					repStorage.Remotes.PlayLavaDamage:FireClient(enemyPlr)
					task.delay(0.9, function()
						debounce[enemy] = false
					end)


					print(`damage start`)
				end
			end)

			task.spawn(function()
				for i = 5, 0, -1 do
					task.wait(1)
					for _, hit in next, workspace:GetPartsInPart(hitbox) do
						local enemy = hit.Parent
						local enemyPlr = game.Players:GetPlayerFromCharacter(enemy)
						--if debounce == true then return end
						if enemy:FindFirstChild("Humanoid") and enemy.Name ~= plr.Name then
							--debounce = true
							--for i, part in enemy:GetChildren() do
							--	if part:IsA("BasePart") then
							--	part.Anchored = true
							--		task.delay(3, function()
							--			part.Anchored = false
							--		end)
							--		end
							--end
							--debounce = false

							if debounce[enemy] then
								continue
							end
							debounce[enemy] = true
							local humanoid: Humanoid = enemy:FindFirstChild("Humanoid")
							humanoid:TakeDamage(35)
							repStorage.Remotes.PlayLavaDamage:FireClient(enemyPlr)
							task.delay(0.9, function()
								debounce[enemy] = false
							end)

						end
					end
				end
				local goal = {}
				goal.Size = Vector3.new(0,0,0)
				local goal2 = {}
				goal2.Size = Vector3.new(0,0,0)
				local tween = TweenService:Create(lava,tweeninfo,goal)
				local tween0 = TweenService:Create(hitbox,tweeninfo,goal2)
				tween:Play()
				tween0:Play()
				tween.Completed:Wait()
				lava:Destroy()
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		SnowGun = function(char: Model, info, plr, look)
			local Players = game:GetService("Players")
			local RunService = game:GetService("RunService")
			local DEBUG_SNOWGUN = true
			local snowGunId = tostring(math.floor(os.clock() * 1000)) .. "-" .. tostring(math.random(1000, 9999))

			local function dbg(message: string)
				if DEBUG_SNOWGUN then
					warn(string.format("[SnowGun:%s][%s] %s", snowGunId, plr.Name, message))
				end
			end

			local hrp = char:FindFirstChild("HumanoidRootPart")
			if not hrp then
				dbg("Cancelled: missing HumanoidRootPart")
				char:SetAttribute("abilityDebounce", false)
				return
			end

			local direction = (look and look.Magnitude > 0) and look.Unit or hrp.CFrame.LookVector

			local tool = char:FindFirstChildOfClass("Tool")
			local origin = hrp.Position + Vector3.new(0, 1.5, 0) + (direction * 2)
			if tool and tool:FindFirstChild("Handle") then
				origin = tool.Handle.Position + Vector3.new(0, 1.25, 0) + (direction * 2)
			end

			do
				local closestDist = 120
				local bestPos: Vector3? = nil

				for _, model in workspace:GetChildren() do
					if model:IsA("Model") and model ~= char then
						local hum = model:FindFirstChildOfClass("Humanoid")
						local targetHrp = model:FindFirstChild("HumanoidRootPart")
						if hum and hum.Health > 0 and targetHrp then
							local offset = targetHrp.Position - origin
							local dist = offset.Magnitude
							if dist > 0 and dist < closestDist then
								local dirTo = offset.Unit
								if dirTo:Dot(direction) > 0.35 then
									closestDist = dist
									bestPos = targetHrp.Position
								end
							end
						end
					end
				end

				if bestPos then
					direction = (bestPos - origin).Unit
				end
			end

			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "SnowGunLaunch")

			local snowball = Instance.new("Part")
			snowball.Name = "SnowGunSnowball"
			snowball.Shape = Enum.PartType.Ball
			snowball.Size = Vector3.new(1.4, 1.4, 1.4)
			snowball.Material = Enum.Material.Ice
			snowball.Color = Color3.fromRGB(245, 245, 255)
			snowball.CanCollide = false
			snowball.CanTouch = false
			snowball.CanQuery = false
			snowball.Massless = true
			snowball.Anchored = true
			snowball.CFrame = CFrame.new(origin, origin + direction)
			snowball.Parent = workspace

			local SPEED = 160
			local MAX_LIFETIME = 3
			local startTime = os.clock()

			dbg(string.format("Spawned at (%.1f, %.1f, %.1f) dir (%.2f, %.2f, %.2f)", origin.X, origin.Y, origin.Z, direction.X, direction.Y, direction.Z))

			local hit = false
			local lastSetSpeedBySnowGun: number? = nil

			local function applySlow(enemyChar: Model, durationSeconds: number)
				local enemyHumanoid = enemyChar:FindFirstChildOfClass("Humanoid")
				if not enemyHumanoid or enemyHumanoid.Health <= 0 then
					return
				end

				local untilTime = os.clock() + durationSeconds
				local prevUntil = enemyChar:GetAttribute("SnowGunSlowUntil")
				if type(prevUntil) == "number" and prevUntil > untilTime then
					untilTime = prevUntil
				end
				enemyChar:SetAttribute("SnowGunSlowUntil", untilTime)

				if enemyChar:GetAttribute("SnowGunSlowActive") then
					return
				end
				enemyChar:SetAttribute("SnowGunSlowActive", true)

				task.spawn(function()
					local enemyPlr = Players:GetPlayerFromCharacter(enemyChar)

					while enemyHumanoid.Parent and enemyHumanoid.Health > 0 do
						local now = os.clock()
						local endAt = enemyChar:GetAttribute("SnowGunSlowUntil")
						if type(endAt) ~= "number" or now >= endAt then
							break
						end

						local baseSpeed = (enemyPlr and enemyPlr:GetAttribute("Speed")) or enemyHumanoid.WalkSpeed
						local desired = math.max(4, math.floor((baseSpeed * 0.5) + 0.5))

						if enemyHumanoid.WalkSpeed > desired then
							enemyHumanoid.WalkSpeed = desired
							lastSetSpeedBySnowGun = desired
						end

						task.wait(0.1)
					end

					enemyChar:SetAttribute("SnowGunSlowActive", false)

					if not enemyHumanoid.Parent or enemyHumanoid.Health <= 0 then
						return
					end

					if lastSetSpeedBySnowGun and enemyHumanoid.WalkSpeed == lastSetSpeedBySnowGun then
						local enemyPlr = Players:GetPlayerFromCharacter(enemyChar)
						local restore = (enemyPlr and enemyPlr:GetAttribute("Speed")) or enemyHumanoid.WalkSpeed
						enemyHumanoid.WalkSpeed = restore
					end

					lastSetSpeedBySnowGun = nil
				end)
			end

			local rayParams = RaycastParams.new()
			rayParams.FilterType = Enum.RaycastFilterType.Exclude
			rayParams.FilterDescendantsInstances = {char, snowball}

			local currentPos = origin
			local conn

			local function cleanup()
				if conn then
					conn:Disconnect()
					conn = nil
				end
				if snowball and snowball.Parent then
					snowball:Destroy()
				end
			end

			local function onImpact(resultInstance: Instance)
				if hit then
					return
				end

				local enemyChar = resultInstance:FindFirstAncestorOfClass("Model")
				if enemyChar and enemyChar ~= char then
					local enemyHumanoid = enemyChar:FindFirstChildOfClass("Humanoid")
					if enemyHumanoid and enemyHumanoid.Health > 0 then
						hit = true
						game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "SnowGunHit")

						local enemyPlr = Players:GetPlayerFromCharacter(enemyChar)
						if enemyPlr then
							game.ReplicatedStorage.Remotes.Sound:FireClient(enemyPlr, "SnowGunHit")
						end

						applySlow(enemyChar, 5)
						dbg("Hit enemy: " .. enemyChar.Name)
						cleanup()
						return
					end
				end

				hit = true
				dbg("Hit non-character: " .. resultInstance:GetFullName())
				cleanup()
			end

			conn = RunService.Heartbeat:Connect(function(dt)
				if hit then
					return
				end
				if not snowball.Parent then
					dbg("Snowball removed externally (Parent nil)")
					cleanup()
					return
				end

				if os.clock() - startTime >= MAX_LIFETIME then
					hit = true
					dbg("Expired (lifetime)")
					cleanup()
					return
				end

				local step = direction * SPEED * dt
				local result = workspace:Raycast(currentPos, step, rayParams)
				if result then
					onImpact(result.Instance)
					return
				end

				currentPos += step
				snowball.CFrame = CFrame.new(currentPos, currentPos + direction)
			end)

			game.Debris:AddItem(snowball, MAX_LIFETIME + 0.25)
			task.delay(MAX_LIFETIME + 0.25, function()
				if not hit then
					hit = true
					dbg("Cleanup fallback fired")
				end
				cleanup()
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce", false)
		end,

		Shockwave = function(char,info,plr)
			local SIZE = 45

			local shockwaveblast = game.ReplicatedStorage.Abilitys.ShockwaveBlast:Clone()
			shockwaveblast.Parent = game.Workspace
			shockwaveblast.Position = char.HumanoidRootPart.Position
			local playerPosition = char:GetPivot().Position
			local ReplicatedStorage = game:GetService("ReplicatedStorage")
			local ts = game:GetService("TweenService")

			local tween = ts:Create(shockwaveblast,TweenInfo.new(0.7, Enum.EasingStyle.Quad, Enum.EasingDirection.In), {Size = Vector3.new(SIZE,SIZE,SIZE)})
			local tween1 =  ts:Create(shockwaveblast,TweenInfo.new(0.3, Enum.EasingStyle.Quad, Enum.EasingDirection.In), {Size = Vector3.new(0,0,0)})
			tween:Play()

			local alreadyHit = {}

			shockwaveblast.Touched:Connect(function(hit)
				local targetchar = hit:FindFirstAncestorOfClass("Model")
				if targetchar and targetchar ~= char and targetchar:FindFirstChild("HumanoidRootPart") then
					if not alreadyHit[targetchar] then
						table.insert(alreadyHit, targetchar)
						targetchar:SetAttribute("killer", plr.Name)

						if not targetchar:HasTag("Untouchable") and not targetchar:HasTag("Fortress") then
							targetchar.IsRagdoll.Value = true
						end


						local humanoidRootPart = targetchar.HumanoidRootPart

						local bodyVelocity = Instance.new("BodyVelocity")
						bodyVelocity.MaxForce = Vector3.new(100000, 100000, 100000)  -- Max force to apply
						local direction = (humanoidRootPart.Position - playerPosition).Unit
						bodyVelocity.Velocity = direction * 125  -- consistent force magnitude
						bodyVelocity.Parent = humanoidRootPart
						game.Debris:AddItem(bodyVelocity, 0.2)

						task.delay(3, function()
							if targetchar then
								targetchar.IsRagdoll.Value = false
							end
						end)
						task.delay(5,function()
							targetchar:SetAttribute("killer", nil)
						end)
					end
				end
			end)

			tween.Completed:Wait()
			tween1:Play()
			tween1.Completed:Wait()
			shockwaveblast:Destroy()
			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		SHOKWAVE = function(char,info,plr)
			local playerPosition = char:GetPivot().Position
			local tool = char:FindFirstChild("Shockwave")
			local HRP = char:FindFirstChild("HumanoidRootPart")
			local centerCFrame = CFrame.new(HRP.Position)
			local boxSize = Vector3.new(50,7,50)
			local overlapParams = OverlapParams.new()
			overlapParams.FilterDescendantsInstances = {char, tool}
			overlapParams.FilterType = Enum.RaycastFilterType.Exclude

			local vfx = repStorage.VFX.SHOKWAVE:Clone()
			vfx.Position = char.HumanoidRootPart.Position
			vfx.Parent = char.HumanoidRootPart

			for i, thing in vfx:GetDescendants() do
				if thing:IsA("ParticleEmitter") then
					thing:Emit(10)
				elseif thing:IsA("Sound") then
					thing:Play()

				end
			end
			game.Debris:AddItem(vfx,3)

			local hitbox = workspace:GetPartBoundsInBox(centerCFrame, boxSize, overlapParams)

			for i, part in ipairs(hitbox) do

				if part.Name == "HumanoidRootPart" then
					local enemyChar = part:FindFirstAncestorOfClass("Model")
					enemyChar:SetAttribute("killer", plr.Name)
					if enemyChar and enemyChar ~= char then
						if not enemyChar:HasTag("Untouchable") and not enemyChar:HasTag("Fortress") then
							enemyChar.IsRagdoll.Value = true
						end
						local humanoidRootPart = enemyChar:FindFirstChild("HumanoidRootPart")

						local bodyVelocity = Instance.new("BodyVelocity")
						bodyVelocity.MaxForce = Vector3.new(math.huge, math.huge, math.huge)  -- Max force to apply
						local direction = (humanoidRootPart.Position - playerPosition).Unit
						bodyVelocity.Velocity = direction * 100000  -- consistent force magnitude
						bodyVelocity.Parent = humanoidRootPart
						game.Debris:AddItem(bodyVelocity, 0.2)

						task.delay(2, function()
							if enemyChar then
								enemyChar.IsRagdoll.Value = false
							end
						end)
						task.delay(5,function()
							enemyChar:SetAttribute("killer", nil)
						end)
					end
				end
			end
			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		Beam = function(char,info,plr, look)

			local raycastParams = RaycastParams.new()
			raycastParams.FilterDescendantsInstances = {char}
			raycastParams.FilterType = Enum.RaycastFilterType.Exclude

			local result = workspace:Raycast(char.HumanoidRootPart.Position, look * 200, raycastParams)

			local clone = game.ReplicatedStorage.Abilitys.Beam:Clone()
			clone.Parent = char.HumanoidRootPart
			local position = char.HumanoidRootPart.Position
			clone.CFrame =	CFrame.new(position, position + look) * CFrame.Angles(0, math.rad(90), 0)
			local clone2 = game.SoundService.laser:Clone()
			clone2.Parent = char.Head
			task.delay(0.00001,function()
				clone2:Play()
			end)
			--clone.CFrame = CFrame.lookAt(char.HumanoidRootPart.Position, result.Position) * CFrame.Angles(0, math.rad(90), 0) C
			game.Debris:AddItem(clone, 0.5) 
			game.Debris:AddItem(clone2, 0.5) 

			if result then
				print(result)
				local hit = result.Instance
				local enemyChar = hit.Parent
				if enemyChar:IsA("Accessory") then
					enemyChar = enemyChar.Parent
				end
				if enemyChar:FindFirstChild("Humanoid") and hit.Parent~= char then
					--	for i, hit in pairs(result) do

					game.ReplicatedStorage.Remotes.ForceKebab:Fire(char, enemyChar, plr)
					--end
				end
			end
			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		Grapple = function(char, info, plr, look)
			local humanoid = char:FindFirstChild("Humanoid")
			local root = char:FindFirstChild("HumanoidRootPart")
			if not humanoid or not root then
				char:SetAttribute("abilityDebounce", false)
				return
			end

			local maxRange = info.Range or 120
			local pullSpeed = info.PullSpeed or 140
			local pullOffset = info.PullOffset or 3
			local ropeLife = info.RopeLifeTime or 0.4
			local hookTravel = info.HookTravelTime or 0.12
			local ropeWidth = info.RopeWidth or 0.15

			local origin = root.Position + Vector3.new(0, 2, 0)
			local raycastParams = RaycastParams.new()
			raycastParams.FilterDescendantsInstances = {char}
			raycastParams.FilterType = Enum.RaycastFilterType.Exclude
			raycastParams.IgnoreWater = true

			local result = workspace:Raycast(origin, look * maxRange, raycastParams)
			local targetPos = nil
			local targetPart = nil
			local targetChar = nil

			if result then
				targetPart = result.Instance
				targetPos = result.Position
				local model = targetPart:FindFirstAncestorOfClass("Model")
				if model and model ~= char and model:FindFirstChild("Humanoid") and model:FindFirstChild("HumanoidRootPart") then
					targetChar = model
					targetPart = model.HumanoidRootPart
					targetPos = targetPart.Position
				end
			end

			local hook = Instance.new("Part")
			hook.Name = "GrappleHook"
			hook.Shape = Enum.PartType.Ball
			hook.Size = Vector3.new(0.5, 0.5, 0.5)
			hook.Material = Enum.Material.Neon
			hook.Color = Color3.fromRGB(50, 50, 50)
			hook.CanCollide = false
			hook.Anchored = true
			hook.CFrame = CFrame.new(origin, origin + look)
			hook.Parent = workspace
			Debris:AddItem(hook, ropeLife + 1)

			local attach0 = Instance.new("Attachment")
			attach0.Name = "GrappleStart"
			attach0.Parent = root

			local attach1 = Instance.new("Attachment")
			attach1.Name = "GrappleEnd"
			attach1.Parent = hook

			local beam = Instance.new("Beam")
			beam.Name = "GrappleRope"
			beam.Attachment0 = attach0
			beam.Attachment1 = attach1
			beam.FaceCamera = true
			beam.Segments = 10
			beam.Width0 = ropeWidth
			beam.Width1 = ropeWidth * 0.7
			beam.Color = ColorSequence.new(Color3.fromRGB(245, 245, 245), Color3.fromRGB(210, 210, 210))
			beam.LightEmission = 0.6
			beam.Parent = root

			local endPos = targetPos or (origin + look * maxRange)
			local hookTween = TweenService:Create(hook, TweenInfo.new(hookTravel, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
				Position = endPos
			})
			hookTween:Play()
			hookTween.Completed:Wait()

			if not result then
				beam:Destroy()
				attach0:Destroy()
				attach1:Destroy()
				repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
				task.wait(info.Cooldown)
				char:SetAttribute("abilityDebounce", false)
				return
			end

			if targetPart then
				hook.CFrame = CFrame.new(targetPos)
				hook.Parent = targetPart
			end

			local distance = (targetPos - root.Position).Magnitude
			if distance > 2 then
				local pullTime = math.clamp(distance / pullSpeed, 0.15, 0.9)
				local dir = (targetPos - root.Position).Unit
				local finalPos = targetPos - dir * pullOffset
				if targetChar and targetPart then
					finalPos = targetPart.Position - dir * pullOffset
				end
				allowBurstForPlayer(plr, {
					kind = "grapple_pull",
					duration = pullTime + 0.35,
					maxDistance = distance + 20,
					allowVertical = true,
					maxHorizontalSpeed = math.max(pullSpeed + 30, 180),
				})
				local pullTween = TweenService:Create(root, TweenInfo.new(pullTime, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
					CFrame = CFrame.new(finalPos, targetPos)
				})
				pullTween:Play()
				pullTween.Completed:Wait()
				markSafePlayer(plr)
			end

			task.delay(ropeLife, function()
				if beam.Parent then
					beam:Destroy()
				end
				if attach0.Parent then
					attach0:Destroy()
				end
				if attach1.Parent then
					attach1:Destroy()
				end
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce", false)
		end,

		Magnet = function(char,info,plr)
			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "zap")
			local attach0 = char.HumanoidRootPart.RootAttachment
			local attach1 = Instance.new("Attachment")
			local beam1 = repStorage.VFX.Magnet1:Clone()
			local beam2 = repStorage.VFX.Magnet2:Clone()
			local beam3 = repStorage.VFX.Magnet3:Clone()
			local nearestplayer = nil
			local shortestdist = 60


			for _, model in pairs(workspace:GetChildren()) do
				if model:IsA("Model") and model:FindFirstChild("Humanoid") and model.Name ~= plr.Name and model:FindFirstChild("Humanoid").Health > 0 then
					local distance = (model.HumanoidRootPart.Position - char.HumanoidRootPart.Position).Magnitude
					if distance < shortestdist then
						print("checkdiddy")
						shortestdist = distance
						nearestplayer = model
					end
				end

			end

			if not nearestplayer then
				game.ReplicatedStorage.TooFarAbility:FireClient(plr)
				char:SetAttribute("abilityDebounce",false)
				return 
			end

			local enemyChar = nearestplayer

			local debounce = false
			if enemyChar then

				local enemyPlr = game.Players:GetPlayerFromCharacter(enemyChar)
				game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "zap")

				if not enemyChar:HasTag("Untouchable")  and not enemyChar:HasTag("Fortress") then
					enemyChar.IsRagdoll.Value = true
				end
				local humanoidRootPart = enemyChar:FindFirstChild("HumanoidRootPart")
				attach1.Parent = humanoidRootPart
				beam1.Attachment0 = attach0
				beam1.Attachment1 = attach1
				beam2.Attachment0 = attach0
				beam2.Attachment1 = attach1
				beam3.Attachment0 = attach0
				beam3.Attachment1 = attach1
				beam1.Parent = char.HumanoidRootPart
				beam2.Parent = char.HumanoidRootPart
				beam3.Parent = char.HumanoidRootPart

				local bodyVelocity = Instance.new("BodyVelocity")
				bodyVelocity.MaxForce = Vector3.new(100000, 100000, 100000)  -- Max force to apply
				bodyVelocity.Velocity = (humanoidRootPart.Position - char.HumanoidRootPart.Position) * -4 -- The direction to fling the player (example: upward)
				bodyVelocity.Parent = humanoidRootPart
				game.Debris:AddItem(bodyVelocity, 0.2)

				local hitbox = Instance.new("Part") -- its not an important hitbox
				hitbox.Size = Vector3.new(30,30,5)
				hitbox.Parent = workspace
				hitbox.Transparency = 1
				hitbox.Position = char.HumanoidRootPart.Position
				hitbox.CanCollide = false
				hitbox.Anchored = true

				hitbox.Touched:Connect(function(hit)
					if hit:IsA("BasePart") and hit.Name == "HumanoidRootPart" and hit.Parent.Name ~= plr.Name and hit.Parent.Name == enemyChar.Name then
						local freeze = Instance.new("BodyVelocity")
						freeze.Velocity = Vector3.zero
						freeze.MaxForce = Vector3.new(1e5,1e5,1e5)
						freeze.P = 1e5
						freeze.Parent = enemyChar.HumanoidRootPart
						game.Debris:AddItem(freeze, 1.5)
					end
				end)
				task.delay(0.4,function()
					beam1:Destroy()
					beam2:Destroy()
					beam3:Destroy()
					attach1:Destroy()
				end)

				task.delay(1.5, function()
					enemyChar.IsRagdoll.Value = false
					hitbox:Destroy()
				end)
			end

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		Swap = function(char,info,plr)
			local nearestplayer = nil
			local shortestdist = 50
			for _, model in pairs(workspace:GetChildren()) do
				if model:IsA("Model") and model:FindFirstChild("Humanoid") and model.Name ~= plr.Name and model:FindFirstChild("Humanoid").Health > 0 then
					if not model.HumanoidRootPart then return end
					local distance = (model.HumanoidRootPart.Position - char.HumanoidRootPart.Position).Magnitude
					if distance < shortestdist then
						shortestdist = distance
						nearestplayer = model
					end
				end
			end
			if nearestplayer and nearestplayer:FindFirstChild("HumanoidRootPart") then
				local nearestpos = nearestplayer.HumanoidRootPart:GetPivot()
				local nearestPlayer = Players:GetPlayerFromCharacter(nearestplayer)
				local swapDistance = (nearestplayer.HumanoidRootPart.Position - char.HumanoidRootPart.Position).Magnitude + 20
				allowBurstForPlayer(plr, {
					kind = "swap",
					duration = 0.75,
					maxDistance = swapDistance,
					allowVertical = true,
					maxHorizontalSpeed = 70,
				})
				allowBurstForPlayer(nearestPlayer, {
					kind = "swap",
					duration = 0.75,
					maxDistance = swapDistance,
					allowVertical = true,
					maxHorizontalSpeed = 70,
				})

				local clone = game.ReplicatedStorage.VFX.Part.TeleportPoof:Clone()
				clone.Parent = char.HumanoidRootPart
				for i, child in clone:GetChildren() do
					if child:IsA("ParticleEmitter") then
						child:Emit(1)
					elseif child.Name == "Poof" then
						child:Play()

					end
				end
				game.Debris:AddItem(clone,0.5)


				local clone2 = game.ReplicatedStorage.VFX.Part.TeleportPoof:Clone()
				clone2.Parent = nearestplayer.HumanoidRootPart
				for i, child in clone2:GetChildren() do
					if child:IsA("ParticleEmitter") then
						child:Emit(1)
					elseif child:IsA("Sound") then
						child:Play()

					end
				end
				game.Debris:AddItem(clone2,0.5)

				nearestplayer.HumanoidRootPart:PivotTo(char.HumanoidRootPart:GetPivot())
				char.HumanoidRootPart:PivotTo(nearestpos)
				markSafePlayer(plr)
				markSafePlayer(nearestPlayer)

				-- Credit the swap caster if the swapped target falls into void shortly after.
				nearestplayer:SetAttribute("killer", plr.Name)
				task.delay(8, function()
					if nearestplayer and nearestplayer.Parent and nearestplayer:GetAttribute("killer") == plr.Name then
						nearestplayer:SetAttribute("killer", nil)
					end
				end)

				repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
				task.wait(info.Cooldown)
				char:SetAttribute("abilityDebounce",false) -- GO BACK
			else
				print("No target found")
				game.ReplicatedStorage.TooFarAbility:FireClient(plr)
				char:SetAttribute("abilityDebounce",false)
			end

		end,

		Anime = function(char,info,plr)
			local clone = game.ReplicatedStorage.Abilitys.Highlight:Clone()
			clone.Parent = char
			game.Debris:AddItem(clone, 0.5)
			local nearestplayer = nil
			local shortestdist = 75
			for _, model in pairs(workspace:GetChildren()) do
				if model:IsA("Model") and model:FindFirstChild("Humanoid") and model.Name ~= plr.Name and model:FindFirstChild("Humanoid").Health > 0 then
					local distance = (model.HumanoidRootPart.Position - char.HumanoidRootPart.Position).Magnitude
					if distance < shortestdist then
						shortestdist = distance
						nearestplayer = model
					end
				end
			end
			if nearestplayer and nearestplayer:FindFirstChild("HumanoidRootPart") then
				print("a")
				local nearestpos = nearestplayer.HumanoidRootPart:GetPivot()
				print("a")
				local offset = 5

				if not nearestplayer.HumanoidRootPart then return end
				local behindpos = nearestplayer.HumanoidRootPart:GetPivot() + (-nearestplayer.HumanoidRootPart.CFrame.LookVector * offset)
				print("a")
				local teleportDistance = (char.HumanoidRootPart.Position - behindpos.Position).Magnitude + 15
				allowBurstForPlayer(plr, {
					kind = "anime_teleport",
					duration = 0.6,
					maxDistance = teleportDistance,
					allowVertical = true,
					maxHorizontalSpeed = 70,
				})
				char.HumanoidRootPart:PivotTo(behindpos)
				print("a")
				markSafePlayer(plr)

				local clone = game.ReplicatedStorage.VFX.Part.TeleportPoof:Clone()
				clone.Parent = char.HumanoidRootPart
				print("a")
				for i, child in clone:GetChildren() do
					if child:IsA("ParticleEmitter") then
						child:Emit(1)
					elseif child.Name == "IT" then
						child:Play()
					end
				end
				game.Debris:AddItem(clone,0.5)

				task.wait(.1)
				repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
				task.wait(info.Cooldown)
				char:SetAttribute("abilityDebounce",false)
			else
				print("No target found")
				game.ReplicatedStorage.TooFarAbility:FireClient(plr)
				char:SetAttribute("abilityDebounce",false)
			end
		end,

		Flashbang = function(char,info,plr)
			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "flashbang")
			local nearestplayer = nil
			local shortestdist = 20

			local hitbox = Instance.new("Part")
			hitbox.Parent = workspace
			hitbox.Size = Vector3.new(35,15,35)
			hitbox.Anchored = true
			hitbox.CanCollide = false
			hitbox.Transparency = 1
			hitbox.Position = char.HumanoidRootPart.Position

			local light = Instance.new("PointLight")
			light.Parent = char.HumanoidRootPart
			light.Brightness = 1500
			light.Range = 20
			game.Debris:AddItem(light, 0.3)
			game.Debris:AddItem(hitbox, 0.3)

			local Players = game:GetService("Players")

			hitbox.Touched:Connect(function(hit)
				if hit.Name == ("HumanoidRootPart") then
					local player = Players:GetPlayerFromCharacter(hit.Parent)
					if player ~= plr then
						print(player)
						repStorage.Remotes.BlurClient:FireClient(player)
						game.ReplicatedStorage.Remotes.Sound:FireClient(player, "flashbang")
						game.ReplicatedStorage.Remotes.Sound:FireClient(player, "flashBang")
					end

					task.wait(.1)
				end
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
			--if nearestplayer and nearestplayer:FindFirstChild("HumanoidRootPart") then
		end,

		Rain = function(char,info,plr)
			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "summon")
			local center = char.HumanoidRootPart.Position
			local range = 20
			for i = 1, 33 do
				local clone = repStorage.Abilitys.Stick:Clone()
				clone.Position = center + Vector3.new(math.random(-range,range), 25, math.random(-range,range))
				clone.Anchored = false
				clone.Parent = workspace

				clone.Touched:Connect(function(hit)
					local enemyChar = hit:FindFirstAncestorOfClass("Model")
					if enemyChar and enemyChar.Name ~= plr.Name and enemyChar:FindFirstChild("Humanoid") and enemyChar:FindFirstChild("Humanoid").Health > 0 then
						clone:Destroy()
						for i, thing in clone:GetDescendants() do
							if thing:IsA("ParticleEmitter") then
								thing:Emit(1)
							end
						end
						repStorage.Remotes.ForceKebab:Fire(char,enemyChar,plr)
					elseif hit.Name == "Stick" then
						clone:Destroy()
					else

						if hit.Parent then
							if hit.Parent == char then
								clone:Destroy()
							end
						end

						clone.Anchored = true
						clone.Position -= Vector3.new(0,2,0)

						if clone:FindFirstChild("Handle") then
							local tween = TweenService:Create(clone.Handle,TweenInfo.new(0.2, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
								Position = (clone.Handle.Position - Vector3.new(0,2,0))
							})
							tween:Play()
						end
						--clone.Handle.Position -= Vector3.new(0,4,0)
					end
				end)

				game.Debris:AddItem(clone,2)

				task.wait(0.05)
			end

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		Slime = function(char,info,plr)
			local run = game:GetService("RunService")
			local debounce = false
			local hum = char.Humanoid
			local tweeninfo = TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
			local duration = 9

			local goal = {}
			goal.Size = Vector3.new(28.5,0.7,26.03)
			local goal2 = {}
			goal2.Size = Vector3.new(28.5, 6.703, 26.03)
			local ice = storage.Slime:Clone()
			local hitbox = ice.Hitbox:Clone()
			local tween = TweenService:Create(ice,tweeninfo,goal)
			local tween0 = TweenService:Create(hitbox,tweeninfo,goal2)
			hitbox.Parent = ice
			ice.Parent = game.Workspace
			local offset = Vector3.new(0,3.8,0)
			ice.Size = Vector3.new(0,0,0)
			hitbox.Size = Vector3.new(0,0,0)
			ice.Position = char:GetPivot().Position - offset
			hitbox.Position = ice:GetPivot().Position
			tween:Play()
			tween0:Play()

			ice.splash:Play()


			hitbox.Touched:Connect(function(hit)
				local enemy = hit.Parent
				local enemyPlr = game.Players:GetPlayerFromCharacter(enemy)
				if enemy:FindFirstChild("Humanoid") and enemy.Name ~= plr.Name then
					enemy.Humanoid.WalkSpeed = 2
					enemy.Humanoid.UseJumpPower = true
					enemy.Humanoid.JumpPower = 0

					task.wait(duration)
					enemy.Humanoid.WalkSpeed = enemyPlr:GetAttribute("Speed")
					enemy.Humanoid.JumpPower = 50	
				end
			end)

			hitbox.TouchEnded:Connect(function(hit)
				local enemy = hit.Parent
				local enemyPlr = game.Players:GetPlayerFromCharacter(enemy)
				if enemy:FindFirstChild("Humanoid") and enemy.Name ~= plr.Name then
					enemy.Humanoid.WalkSpeed = enemyPlr:GetAttribute("Speed")
					enemy.Humanoid.JumpPower = 50	
				end
			end)

			task.delay(duration, function()
				local goal = {}
				goal.Size = Vector3.new(0,0,0)
				local goal2 = {}
				goal2.Size = Vector3.new(0,0,0)
				local tween = TweenService:Create(ice,tweeninfo,goal)
				local tween0 = TweenService:Create(hitbox,tweeninfo,goal2)
				tween:Play()
				tween0:Play()
				tween.Completed:Wait()
				ice:Destroy()
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		Smite = function(char,info,plr)
			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "storm")
			local run = game:GetService("RunService")

			local loop
			local cloud = repStorage.Abilitys.Cloud:Clone()
			cloud.Parent = workspace
			local offset = Vector3.new(0,9,0)
			local tween = TweenService:Create(cloud.Mesh,TweenInfo.new(1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {
				Scale = Vector3.new(10,10,10)
			})
			tween:Play()

			local hitbox = Instance.new("Part")
			hitbox.Size = Vector3.new(28,10,28)
			hitbox.Anchored = true
			hitbox.CanCollide = false
			hitbox.Parent = workspace
			hitbox.Transparency = 1



			loop = run.Stepped:Connect(function()
				cloud.Position = char.HumanoidRootPart.Position + offset
				hitbox.Position = char.HumanoidRootPart.Position
				if char:FindFirstChild("Humanoid").Health <= 0 then
					hitbox:Destroy()
				end
			end)


			hitbox.Touched:Connect(function(hit)
				if hit:IsA("BasePart") and hit.Name == "HumanoidRootPart" and hit.Parent.Name ~= plr.Name and hit.Parent:FindFirstChild("Humanoid").Health > 0 then
					local beam = repStorage.Abilitys.lightningBeam:Clone()
					beam.Parent = cloud
					local attach0 = Instance.new("Attachment")
					attach0.Parent = cloud
					local attach1 = Instance.new("Attachment")
					attach1.Parent = hit
					beam.Attachment0 = attach0
					beam.Attachment1 = attach1
					game.Debris:AddItem(beam,0.2)
					game.Debris:AddItem(attach1,0.2)

					if hit:FindFirstChild("LightningStrike") then
						print("no")
					else
						local vfx = repStorage.VFX.LightningStrike:Clone()
						vfx.Position = hit.Parent.HumanoidRootPart.Position
						vfx.Parent = hit.Parent.HumanoidRootPart

						task.wait(0.01)
						for i, thing in vfx:GetDescendants() do
							if thing:IsA("ParticleEmitter") then
								thing:Emit(5)
							elseif thing:IsA("Sound") then
								thing:Play()
							end
						end
						game.Debris:AddItem(vfx,5)

						local enemyChar = hit.Parent
						if not enemyChar:HasTag("Untouchable") and not enemyChar:HasTag("Fortress") then
							enemyChar.IsRagdoll.Value = true
						end
						local bodyVelocity = Instance.new("BodyVelocity")
						bodyVelocity.MaxForce = Vector3.new(1e5, 1e5, 1e5)  -- Max force to apply
						bodyVelocity.Velocity = (hit.Position - char.HumanoidRootPart.Position) * -1 -- The direction to fling the player (example: upward)
						bodyVelocity.Parent = hit
						game.Debris:AddItem(bodyVelocity, 0.2)

						task.delay(3, function()
							if enemyChar.Humanoid.Health > 0 then
								enemyChar.IsRagdoll.Value = false
							end
						end)
					end

				end
			end)
			task.wait(10)
			if loop then
				loop:Disconnect()
				cloud:Destroy()
				hitbox:Destroy()
			end
			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		Shield = function(char,info,plr)
			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "forceshield")
			char:SetAttribute("Protected", true)

			local clone = game.ReplicatedStorage.Abilitys.Shield:Clone()
			clone.Parent = char.HumanoidRootPart

			local tweenInfo = TweenInfo.new(
				0.4,                      -- Time (in seconds)
				Enum.EasingStyle.Quad,  -- Easing style
				Enum.EasingDirection.Out
			)

			clone.Size = Vector3.new(0,0,0)
			local tween = TweenService:Create(clone, tweenInfo, {Size = Vector3.new(9, 9, 9)})
			tween:Play()

			local weld =Instance.new("WeldConstraint")
			weld.Parent = char.HumanoidRootPart
			weld.Part0 = char.HumanoidRootPart
			weld.Part1 = clone
			clone.Position = char.HumanoidRootPart.Position
			task.wait(5)
			char:SetAttribute("Protected", false)


			local tweenInfo2 = TweenInfo.new(
				0.2,                      -- Time (in seconds)
				Enum.EasingStyle.Quad,  -- Easing style
				Enum.EasingDirection.Out
			)

			local tween2 = TweenService:Create(clone, tweenInfo2, {Size = Vector3.new(0, 0, 0)})
			tween2:Play()
			tween2.Completed:Wait()
			clone:Destroy()

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		UFO = function(char: Model, info, plr)
			local run = game:GetService("RunService")
			local repStorage = game:GetService("ReplicatedStorage")
			local targeted = {}
			local debounce = false

			local UFO = repStorage.Abilitys.UFO:Clone()
			UFO.Parent = workspace
			UFO.Hitbox.spawnUFO:Play()

			UFO:PivotTo(char:GetPivot())
			task.wait(0.2)
			--UFO.Beam.Transparency = 0.2

			local currentTarget = nil
			local abducting = false

			local function ScanForNearbyPlayers()
				local closestChar = nil
				local closestDistance = math.huge
				local origin = UFO:GetPivot().Position

				for _, Char in workspace:GetChildren() do
					if Char:IsA("Model") and Char:FindFirstChildOfClass("Humanoid") and Char.Humanoid.Health > 0 and Char ~= char and Char:GetAttribute("SafeZone") == false then
						if not Char:GetAttribute("Abducted") and not table.find(targeted, Char) then
							local dist = (origin - Char:GetPivot().Position).Magnitude
							if dist < closestDistance and dist <= 30 then
								closestDistance = dist
								closestChar = Char
							end
						end
					end
				end

				return closestChar
			end

			local loop
			loop = run.Stepped:Connect(function()
				-- Target scanning only when idle
				if not abducting and not currentTarget then
					currentTarget = ScanForNearbyPlayers()
				end

				if not abducting then
					local followPos = currentTarget and currentTarget:GetPivot().Position or char:GetPivot().Position
					local desiredCFrame = CFrame.new(followPos + Vector3.new(0, 25, 0))
					local smoothCFrame = UFO:GetPivot():Lerp(desiredCFrame, 0.1)
					UFO:PivotTo(smoothCFrame)
				end

				if currentTarget and not table.find(targeted, currentTarget) and not abducting and UFO.PrimaryPart and char.IsRagdoll.Value == false then
					local enemyChar = currentTarget
					if enemyChar and enemyChar.PrimaryPart and enemyChar:FindFirstChild("Humanoid") and enemyChar.Humanoid.Health > 0 then
						local beam = UFO:FindFirstChild("Beam")
						if not beam then warn("Missing beam") return end

						local beamBottom = beam.Position - Vector3.new(0, beam.Size.Y / 2, 0)
						local targetPos = enemyChar:GetPivot().Position
						local distance = (beamBottom - targetPos).Magnitude

						print("Trying to abduct:", enemyChar.Name, "Distance:", distance)

						if distance <= 5 then
							abducting = true
							table.insert(targeted, enemyChar)

							--local ragdoll = enemyChar:FindFirstChild("IsRagdoll")
							--if ragdoll and ragdoll:IsA("BoolValue") then
							--	ragdoll.Value = true
							--end

							--task.delay(1, function()
							--if enemyChar then
							--	enemyChar.IsRagdoll = false
							--end
							--end)
						end
					end
				end


				if abducting and currentTarget and currentTarget.PrimaryPart then
					local ufoPos = UFO.Pos.Position
					UFO.Beam.Transparency = 0.2
					UFO.Beam.Attachment.ParticleEmitter.Enabled = true
					allowBurstForCharacter(currentTarget, {
						kind = "ufo_abduct",
						duration = 0.25,
						maxDistance = 60,
						allowVertical = true,
						maxHorizontalSpeed = 80,
					})
					currentTarget:PivotTo(CFrame.new(ufoPos))
				end

				-- Reset target if invalid
				if currentTarget then
					local hum = currentTarget:FindFirstChild("Humanoid")
					if not currentTarget:IsDescendantOf(workspace) or not hum or hum.Health <= 0 then
						-- Remove from targeted if it's already marked but now dead
						local idx = table.find(targeted, currentTarget)
						if idx then table.remove(targeted, idx) end

						currentTarget = nil
						abducting = false

					end
				end
			end)

			print(currentTarget)
			local touchedConn = UFO.Hitbox.Touched:Connect(function(hit)
				if not debounce then
					if hit and hit.Parent == currentTarget then
						print("hit!")
						debounce = true

						if currentTarget and currentTarget.PrimaryPart and currentTarget:FindFirstChild("Humanoid") and currentTarget.Humanoid.Health > 0 then
							repStorage.Remotes.ForceKebab:Fire(char, currentTarget, plr)
						end

						UFO.Hitbox.beamUFO:Play()

						local idx = table.find(targeted, currentTarget)
						if idx then table.remove(targeted, idx) end

						currentTarget = nil
						abducting = false

						task.delay(3,function()
							debounce = false

							if UFO:FindFirstChild("Beam") then
								UFO.Beam.Transparency = 1
								UFO.Beam.Attachment.ParticleEmitter.Enabled = false
							end
						end)
					end
				end
			end)

			local removal = workspace.ChildRemoved:Connect(function(child)
				if child == currentTarget then
					currentTarget = nil
					abducting = false
				end
				local idx = table.find(targeted, child)
				if idx then table.remove(targeted, idx) end
			end)

			local ownerDeath

			ownerDeath = char:FindFirstChild("Humanoid").Died:Connect(function()
				if loop then loop:Disconnect() end
				if touchedConn then touchedConn:Disconnect() end
				if removal then removal:Disconnect() end
				ownerDeath:Disconnect()

				UFO:Destroy()
			end)

			task.delay(11, function()
				if UFO and UFO.PrimaryPart then
					if loop then loop:Disconnect() end
					if touchedConn then touchedConn:Disconnect() end
					if removal then removal:Disconnect() end

					UFO:Destroy()
					repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
					task.delay(info.Cooldown,function()
						char:SetAttribute("abilityDebounce", false)
					end)
				end
			end)
		end,

		killBrick = function(char, info, plr)
			local debounce = false

			--if table.find(info.Exclusive,plr.Name) then
			if char and char.PrimaryPart and char.Humanoid.Health > 0 then
				local Part = Instance.new("Part")
				Part.Material = Enum.Material.Neon
				Part.Color = Color3.fromRGB(255, 0, 0)

				local touched

				local function Remove()
					if touched then touched:Disconnect() end

					Part:Destroy()
				end

				char:FindFirstChild("Humanoid").Died:Connect(Remove)

				touched = Part.Touched:Connect(function(hit)
					if hit and hit.Parent:FindFirstChild("Humanoid") and hit.Parent ~= char then
						if not debounce then
							debounce = true
							repStorage.Remotes.ForceKebab:Fire(char,hit.Parent,plr)

							task.delay(0.3,function()
								debounce = false
							end)
						end
					end
				end)

				Part:PivotTo(char:GetPivot() * CFrame.new(0,0,-5))
				Part.Parent = workspace


				task.delay(12,Remove)

				repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

				task.delay(info.Cooldown,function()
					char:SetAttribute("abilityDebounce", false)
				end)
			end
			--end
		end,


		Tsunami = function(char,info,plr)
			local run = game:GetService("RunService")
			local wave = game.ReplicatedStorage.Abilitys.wave:Clone()
			local hit = {}

			wave:PivotTo(char.HumanoidRootPart:GetPivot() * CFrame.new(0,-0.1,-12))

			wave.Name = char.Name.." Wave"

			wave.Cube.sound:Play()

			local Params = OverlapParams.new()
			Params.FilterDescendantsInstances = {char,wave}
			Params.FilterType = Enum.RaycastFilterType.Exclude

			local RayParams = RaycastParams.new()
			RayParams.FilterDescendantsInstances = {wave, workspace.VoidParts, char}
			RayParams.FilterType = Enum.RaycastFilterType.Exclude

			local random = Random.new()
			local raycastPart = wave.PrimaryPart

			wave.Parent = workspace

			local loop, destroyed

			task.delay(2,function()
				if wave and wave.PrimaryPart then
					raycastPart = wave.Raycast
				end
			end)

			loop = run.Stepped:Connect(function()
				if wave and wave.PrimaryPart then
					-- move wave forward
					local SmoothCF = wave:GetPivot():Lerp(wave:GetPivot() * CFrame.new(0,0,-2),0.2)

					wave:PivotTo(SmoothCF)

					-- check if the wave is over the void
					local raycast = workspace:Raycast(raycastPart.Position,Vector3.new(0,-100,0),RayParams)

					--print(RayParams.FilterDescendantsInstances)

					if not raycast or not raycast.Instance then

						--task.delay(0.2,function()
						loop:Disconnect()
						destroyed:Disconnect()
						wave:Destroy()
						--end)

						repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

						task.delay(info.Cooldown,function()
							char:SetAttribute("abilityDebounce", false)
						end)
					end

					-- make the wave bigger

					wave:ScaleTo(wave:GetScale() + 0.001)
					wave:PivotTo(wave:GetPivot() * CFrame.new(0,0.01,0))


					-- check for hit

					if wave.PrimaryPart then

						local touching = workspace:GetPartsInPart(wave.PrimaryPart,Params)

						for i,v in touching do
							if v.Parent and v.Parent:IsA("Model") and v.Parent.PrimaryPart and v.Parent:GetAttribute("SafeZone") ~= true then

								if v.Parent:HasTag("Wave") then
									if wave:GetScale() > v.Parent:GetScale() then
										v.Parent:Destroy()
										return
									end
								end

								if v.Parent:FindFirstChild("Humanoid") and v.Parent.Humanoid.Health > 0 and not table.find(hit,v.Parent) then
									local enemy = v.Parent

									if not table.find(hit,enemy) and #hit < 4 then
										table.insert(hit,enemy)

										--	enemy.IsRagdoll.Value = true

										-- move them to a random point on the wave

										local x = random:NextNumber(-wave.PrimaryPart.Size.X/2, wave.PrimaryPart.Size.X/2)


										enemy.PrimaryPart.CFrame = wave.PrimaryPart.CFrame * CFrame.new(x,0,0) * CFrame.Angles(0,math.rad(180),0)

										enemy:SetAttribute("killer", plr.Name)
										task.delay(10, function()
											if enemy and enemy.Parent and enemy:GetAttribute("killer") == plr.Name then
												enemy:SetAttribute("killer", nil)
											end
										end)

										local weld = Instance.new("WeldConstraint")
										weld.Part0 = wave.PrimaryPart
										weld.Part1 = enemy.PrimaryPart
										weld.Name = enemy.Name


										weld.Parent = wave.PrimaryPart
									end
								end
							end
						end
					end
				end
			end)


			destroyed = wave.Destroying:Connect(function()
				loop:Disconnect()
				destroyed:Disconnect()

				repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

				task.delay(info.Cooldown,function()
					char:SetAttribute("abilityDebounce", false)
				end)
			end)
		end,


		Nuke = function(char,info,plr)
			local hitbox = game.ReplicatedStorage.Abilitys.KillZone:Clone()
			hitbox.Parent = workspace

			hitbox.KillZone.Position = char.HumanoidRootPart.Position - Vector3.new(0, 2.5, 0)
			hitbox.NukeVFX.Position = char.HumanoidRootPart.Position- Vector3.new(0, 2.5, 0)
			hitbox.ShockZone.Position = char.HumanoidRootPart.Position- Vector3.new(0, 2.5, 0)


			game.Debris:AddItem(hitbox.KillZone, 1)
			game.Debris:AddItem(hitbox.ShockZone, 1)
			game.Debris:AddItem(hitbox, 10)


			task.wait(0.01)
			for i, thing in hitbox.NukeVFX:GetDescendants() do
				if thing:IsA("ParticleEmitter") then
					if thing.Name == "Crack" then
						thing:Emit(1)
					else
						thing:Emit(5)
					end

				end
			end

			hitbox.NukeVFX.nukeExplode:Play()
			task.delay(0,function()
				hitbox.NukeVFX.shockwave:Play()
			end)

			hitbox.KillZone.Touched:Connect(function(hit)
				if hit.Parent then
					if hit.Parent:FindFirstChild("Humanoid") and hit.Parent ~= char then
						local enemyChar = hit.Parent
						if enemyChar.Humanoid.Health <= 0 then return end
						game.ReplicatedStorage.Remotes.ForceKebab:Fire(char, enemyChar, plr)
					end
				end
			end)

			task.wait(0.25)
			hitbox.ShockZone.Touched:Connect(function(hit)
				local enemyChar = hit.Parent
				local playerPosition = char:GetPivot().Position
				enemyChar:SetAttribute("killer", plr.Name)
				if enemyChar and enemyChar ~= char and enemyChar:FindFirstChild("HumanoidRootPart")then
					if enemyChar:FindFirstChild("IsRagdoll") and not enemyChar:HasTag("Untouchable") and not enemyChar:HasTag("Fortress") then
						enemyChar.IsRagdoll.Value = true
					end

					local humanoidRootPart = enemyChar:FindFirstChild("HumanoidRootPart")

					local bodyVelocity = Instance.new("BodyVelocity")
					bodyVelocity.MaxForce = Vector3.new(100000, 100000, 100000)  -- Max force to apply
					local direction = (humanoidRootPart.Position - playerPosition).Unit
					bodyVelocity.Velocity = direction * 30  -- consistent force magnitude
					bodyVelocity.Parent = humanoidRootPart
					game.Debris:AddItem(bodyVelocity, 0.2)

					task.delay(2, function()
						if enemyChar then
							enemyChar.IsRagdoll.Value = false
						end
					end)
					task.delay(5,function()
						enemyChar:SetAttribute("killer", nil)
					end)
				end
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

			task.delay(info.Cooldown,function()
				char:SetAttribute("abilityDebounce", false)
			end)
		end,

		Extend = function(char,info,plr)
			local smallStick = char:FindFirstChild("Elongated Stick")
			local loop = false
			local bigStick = repStorage.Abilitys["Elongated Stick"]:Clone()
			if smallStick and smallStick.Handle then
				local tween = TweenService:Create(smallStick.Handle,TweenInfo.new(1,Enum.EasingStyle.Quad,Enum.EasingDirection.In),{Size = bigStick.Handle.Size})
				tween:Play()

				tween.Completed:Connect(function()
					bigStick.Parent = char
					smallStick.Parent = repStorage.Abilitys
				end)

				local kebab = bigStick:WaitForChild("Kebab")
				if kebab then
					smallStick.Parent = char
					kebab.Parent = smallStick
					bigStick.Parent = repStorage.Abilitys
					bigStick:Destroy()
				end

				repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

				task.delay(info.Cooldown,function()
					char:SetAttribute("abilityDebounce", false)
				end)
			end
		end,

		Summoner = function(char, info, Player)
			local repStorage = game:GetService("ReplicatedStorage")
			local SkeletonClass = require(game.ServerStorage.ServerClasses.Skeleton)

			local Skeletons = {}

			local Bindable = Instance.new("BindableEvent")

			local function Cleanup()
				for Skele, data in Skeletons do
					data:Destroy()
				end

				Bindable:Destroy()
			end

			repStorage.Remotes.Sound:FireClient(Player, "skeletons")

			task.spawn(function()
				for i = 1, 3 do
					local newSkele = repStorage.Abilitys.Skeleton:Clone()

					newSkele:PivotTo(CFrame.new(char:GetPivot().Position + char:GetPivot().RightVector * 5 + Vector3.new(math.random(-5, 5), 0, math.random(-5, 5))))
					newSkele.Parent = workspace

					Skeletons[newSkele] = SkeletonClass.new(newSkele,Player,Bindable)

					newSkele.Destroying:Connect(function()
						if Skeletons and Skeletons[newSkele] then
							Skeletons[newSkele] = nil
						end
					end)
				end
			end)

			char.Humanoid.Died:Connect(Cleanup)
			Player.Destroying:Connect(Cleanup)

			task.delay(10, Cleanup)

			repStorage.Remotes.AbilityCooldown:FireClient(Player, info.Cooldown)

			task.delay(info.Cooldown, function()
				char:SetAttribute("abilityDebounce", false)
			end)
		end,


		Mine = function(char, info, plr)
			local debounce = false

			--if table.find(info.Exclusive,plr.Name) then
			if char and char.PrimaryPart and char.Humanoid.Health > 0 then
				local Mine = repStorage.Abilitys.LandMine:Clone()
				local origin

				local touched

				local function Remove()
					if touched then touched:Disconnect() end

					Mine:Destroy()
				end

				char:FindFirstChild("Humanoid").Died:Connect(Remove)

				touched = Mine.Detonate.Touched:Connect(function(hit)
					if hit and hit.Parent:FindFirstChild("Humanoid") and hit.Parent ~= char then
						if not debounce then
							debounce = true

							local boom = Instance.new("Explosion",workspace.Debris)
							boom.BlastPressure = 0
							boom.BlastRadius = 15
							boom.Position = origin

							Mine.Detonate.Sound:Play()

							Mine:Destroy()

							local hitChars = {}

							boom.Hit:Connect(function(hit,dist)
								if hit.Parent and hit.Parent:FindFirstChild("Humanoid") and hit.Parent ~= char and hit.Parent.IsRagdoll.Value == false then
									if not table.find(hitChars,hit.Parent) then
										table.insert(hitChars,hit.Parent)

										local enemyChar = hit.Parent

										enemyChar:SetAttribute("Killer",plr.Name)

										if enemyChar:FindFirstChild("IsRagdoll") and not enemyChar:HasTag("Untouchable") and not enemyChar:HasTag("Fortress") then
											enemyChar.IsRagdoll.Value = true
										end

										local humanoidRootPart = enemyChar:FindFirstChild("HumanoidRootPart")

										local bodyVelocity = Instance.new("BodyVelocity")
										bodyVelocity.MaxForce = Vector3.new(100000, 100000, 100000)  -- Max force to apply
										local direction = (humanoidRootPart.Position - origin).Unit
										bodyVelocity.Velocity = direction * 15  -- consistent force magnitude
										bodyVelocity.Parent = humanoidRootPart
										game.Debris:AddItem(bodyVelocity, 0.2)

										task.delay(2, function()
											if enemyChar then
												enemyChar.IsRagdoll.Value = false
											end
										end)

										task.delay(5,function()
											enemyChar:SetAttribute("Killer",nil)
										end)

										plr.leaderstats.Coins.Value += 15
									end
								end
							end)
						end
					end
				end)

				Mine:PivotTo(char:GetPivot() * CFrame.new(0,0,-5))
				Mine.Parent = workspace


				origin = Mine:GetPivot().Position


				task.delay(20,Remove)

				repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

				task.delay(info.Cooldown,function()
					char:SetAttribute("abilityDebounce", false)
				end)
			end
			--end
		end,

		Rage = function(char, info, plr, look)
			local time = 1
			local startstop = nil

			local hum = char.Humanoid
			hum.UseJumpPower = true
			local originalspeed = hum.WalkSpeed
			local playing
			local tool = char:FindFirstChild("Rage")
			local run = game:GetService("RunService")


			local hitbox = Instance.new("Part")
			hitbox.Size = Vector3.new(5, 8, 6)
			hitbox.Anchored = true
			hitbox.Transparency = 1
			hitbox.CanCollide = false
			hitbox.Parent = workspace

			local bv = Instance.new("BodyVelocity")
			bv.Velocity = look * 80
			bv.MaxForce = Vector3.new(1e5, 0 ,1e5)
			bv.P = 1e5
			allowBurstForPlayer(plr, {
				kind = "rage_charge",
				duration = time + 0.2,
				maxDistance = 110,
				maxHorizontalSpeed = 95,
			})
			hum.WalkSpeed = 0
			hum.JumpPower = 0
			bv.Parent = char.HumanoidRootPart
			repStorage.Remotes.RageAnimation:FireClient(plr,startstop)
			playing = true

			local clone = game.ReplicatedStorage.Abilitys.rage:Clone()
			clone.Parent = char
			game.Debris:AddItem(clone, time)

			local clone2 = game.ReplicatedStorage.Abilitys.rage2:Clone()
			clone2.Parent = char.HumanoidRootPart
			game.Debris:AddItem(clone2, time + 4)

			local connection = run.Stepped:Connect(function()
				if char:FindFirstChild("HumanoidRootPart") then
					hitbox.CFrame = char.HumanoidRootPart.CFrame * CFrame.new(0,0,-2)
					task.wait(0.1)
				end
			end)

			hitbox.Touched:Connect(function(player)
				local enemyChar = player:FindFirstAncestorWhichIsA("Model")
				if enemyChar and enemyChar:FindFirstChild("Humanoid") then
					if enemyChar ~= char then
						repStorage.Remotes.ForceKebab:Fire(char,enemyChar,plr)
					end
				else
					warn("Hit tool")
				end
			end)

			task.delay(time,function()
				bv:Destroy()
				hitbox:Destroy()
				hum.WalkSpeed = originalspeed
				hum.JumpPower = 50
				clone2.Enabled = false

			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

			task.delay(info.Cooldown,function()
				char:SetAttribute("abilityDebounce", false)
			end)
		end,

		Luck = function(char, info, plr, look)
			local lifetime = 8
			local hum: Humanoid = char.Humanoid
			local jump = hum.JumpPower
			local speed = hum.WalkSpeed
			local loop
			local luckyblock = repStorage.Abilitys.LuckyBlock:Clone()
			local rotationConnection
			luckyblock.Parent = workspace

			luckyblock.Orientation = Vector3.new(0, 0, 0)

			local duration = 1 -- Initial duration in seconds
			local minDuration = 0.2 -- Cap the speed to avoid going too fast

			local function startRotationTween()
				local goal = {Orientation = Vector3.new(0, luckyblock.Orientation.Y + 180, 0)}
				local tweenInfo = TweenInfo.new(duration, Enum.EasingStyle.Linear)
				local tween = TweenService:Create(luckyblock, tweenInfo, goal)

				rotationConnection = tween.Completed:Connect(function()
					-- Decrease duration to speed up, but cap it at minDuration
					duration = math.max(duration * 0.65, minDuration)
					startRotationTween() -- Start a new faster tween
				end)

				tween:Play()
			end

			startRotationTween()

			local run = game:GetService("RunService")
			loop = run.Stepped:Connect(function()
				luckyblock.Position = char.HumanoidRootPart.Position + Vector3.new(0,6,0)
				if char:FindFirstChild("Humanoid").Health <= 0 then
					luckyblock:Destroy()
				end
			end)

			task.wait(3)
			--luckyblock:Destroy()
			rotationConnection:Disconnect()

			for i, vfx in luckyblock:GetDescendants() do
				if vfx:IsA("ParticleEmitter") then
					vfx:Emit(5)
				end
				if vfx:IsA("Decal") then
					vfx:Destroy()
				end
			end

			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "powerup")

			local function LongStick()
				local smallStick = char:FindFirstChild("Lucky Stick")
				local origsize = smallStick.Handle.Size
				local loop = false
				local bigStick = repStorage.Abilitys["Elongated Stick"]

				if smallStick and smallStick.Handle then
					local tween = TweenService:Create(smallStick.Handle,TweenInfo.new(1,Enum.EasingStyle.Quad,Enum.EasingDirection.In),{Size = bigStick.Handle.Size})
					tween:Play()

					task.wait(lifetime)

					local tween2 = TweenService:Create(smallStick.Handle,TweenInfo.new(1,Enum.EasingStyle.Quad,Enum.EasingDirection.In),{Size = origsize})
					tween2:Play()
				end
			end

			local function Summon()
				local SkeletonClass = require(game.ServerStorage.ServerClasses.Skeleton)
				local Summons = {}

				local Bindable = Instance.new("BindableEvent")


				local function Cleanup()
					for Skele, data in Summons do
						data:Destroy()
					end

					Bindable:Destroy()
				end

				local Portal = repStorage.Abilitys.Portal:Clone()

				Portal:PivotTo(char:GetPivot() * CFrame.new(0,-10,5))

				local tweenInfo = TweenInfo.new(3,Enum.EasingStyle.Linear,Enum.EasingDirection.In)
				local tween = TweenService:Create(Portal,tweenInfo,{Position = Portal.Position + Vector3.new(0,10,0)})
				tween:Play()
				Portal.Parent = workspace.Debris

				Portal.open:Play()
				Portal["Fortnite - Portal Open Ambient Noise"]:Play()

				tween.Completed:Connect(function()
					for i = 1, 10 do						
						if char.Humanoid.Health <= 0 or not plr then
							break
						end

						local newSkele = repStorage.Abilitys.shadow:Clone()

						newSkele:PivotTo(Portal:GetPivot())
						newSkele.Parent = workspace

						Portal.summon:Play()

						Summons[newSkele] = SkeletonClass.new(newSkele,plr,Bindable)

						newSkele.Destroying:Connect(function()
							if Summons and Summons[newSkele] then
								Summons[newSkele] = nil
							end
						end)

						task.wait(1)
					end

					Portal:Destroy()
					task.delay(12,Cleanup)
				end)

				char.Humanoid.Died:Connect(Cleanup)
				plr.Destroying:Connect(Cleanup)
			end

			local function Untouchable()
				char:AddTag("Untouchable")
				--	local highlight = repStorage.Abilitys.untouch:Clone()
				--highlight.Parent = char
				task.delay(lifetime,function()
					char:RemoveTag("Untouchable")
					--highlight:Destroy()
				end)
			end

			local function ff()
				game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "forceshield")
				--char:SetAttribute("Protected", true)
				char:AddTag("OneTimeShield")

				local clone = game.ReplicatedStorage.Abilitys.Shield:Clone()
				clone.Parent = char.HumanoidRootPart

				local tweenInfo = TweenInfo.new(
					0.4,                      -- Time (in seconds)
					Enum.EasingStyle.Quad,  -- Easing style
					Enum.EasingDirection.Out
				)

				clone.Size = Vector3.new(0,0,0)
				local tween = TweenService:Create(clone, tweenInfo, {Size = Vector3.new(9, 9, 9)})
				tween:Play()

				local weld =Instance.new("WeldConstraint")
				weld.Parent = char.HumanoidRootPart
				weld.Part0 = char.HumanoidRootPart
				weld.Part1 = clone
				clone.Position = char.HumanoidRootPart.Position
				task.wait(lifetime)
				--char:SetAttribute("Protected", false)

				char:RemoveTag("OneTimeShield")

				local tweenInfo2 = TweenInfo.new(
					0.2,                      -- Time (in seconds)
					Enum.EasingStyle.Quad,  -- Easing style
					Enum.EasingDirection.Out
				)

				local tween2 = TweenService:Create(clone, tweenInfo2, {Size = Vector3.new(0, 0, 0)})
				tween2:Play()
				tween2.Completed:Wait()
				clone:Destroy()
			end

			local abilities = { --  TODO: set the chances and gradients
				["Speed Boost"] = {
					chance = 1.5,
					Gradient = ColorSequence.new({
						ColorSequenceKeypoint.new(0,Color3.fromRGB(255, 255, 0)),
						ColorSequenceKeypoint.new(1,Color3.fromRGB(255, 213, 0))
					})
				},
				["Long Skewer"] = {
					chance = 1,
					Gradient = ColorSequence.new({
						ColorSequenceKeypoint.new(0,Color3.fromRGB(85, 255, 0)),
						ColorSequenceKeypoint.new(1,Color3.fromRGB(0, 255, 0))
					})
				},
				["Summon"] = {
					chance = 0.5,
					Gradient = ColorSequence.new({
						ColorSequenceKeypoint.new(0,Color3.fromRGB(0, 0, 0)),
						ColorSequenceKeypoint.new(1,Color3.fromRGB(170, 0, 255))
					})
				},
				["Untouchable"] = {
					chance = 0.5,
					Gradient = ColorSequence.new({
						ColorSequenceKeypoint.new(0,Color3.fromRGB(170, 255, 255)),
						ColorSequenceKeypoint.new(1,Color3.fromRGB(255, 255, 255))
					})
				},
				["Slowed"] = {
					chance = 0.5,
					Gradient = ColorSequence.new({
						ColorSequenceKeypoint.new(0,Color3.fromRGB(170, 0, 0)),
						ColorSequenceKeypoint.new(1,Color3.fromRGB(255, 0, 0))
					})
				},

				["Jump Boost"] = {
					chance = 1.5,
					Gradient = ColorSequence.new({
						ColorSequenceKeypoint.new(0,Color3.fromRGB(0, 85, 255)),
						ColorSequenceKeypoint.new(1,Color3.fromRGB(0, 170, 255))
					})
				},
				["No Jump"] = {
					chance = 1,
					Gradient = ColorSequence.new({
						ColorSequenceKeypoint.new(0,Color3.fromRGB(170, 0, 0)),
						ColorSequenceKeypoint.new(1,Color3.fromRGB(255, 0, 0))
					})
				},
				["ForceField"] = {
					chance = 1,
					Gradient = ColorSequence.new({
						ColorSequenceKeypoint.new(0,Color3.fromRGB(0, 170, 255)),
						ColorSequenceKeypoint.new(1,Color3.fromRGB(0, 85, 255))
					})
				},
			}
			local weight = 0

			hum.UseJumpPower = true

			for _, data in pairs(abilities) do
				weight += (data.chance * 10)
			end
			local ran = math.random(1, weight)

			weight = 0

			for ability, data in pairs(abilities) do
				weight += (data.chance * 10)
				if weight >= ran then
					print(ability)
					repStorage.Remotes.PromptLucky:FireClient(plr,ability,data.Gradient)
					if ability == "Speed Boost" then
						local original = hum.WalkSpeed

						hum.WalkSpeed *= 2

						char:SetAttribute("abilityDebounce",true)

						repStorage.Remotes.AbilityCooldown:FireClient(plr, lifetime)
						--elseif ability == "Speed2x" then
						--	hum.WalkSpeed *= 2
					elseif ability == "Slowed" then
						local original = hum.WalkSpeed

						hum.WalkSpeed *= 0.5

						char:SetAttribute("abilityDebounce",true)

						repStorage.Remotes.AbilityCooldown:FireClient(plr, lifetime)
						--elseif ability == "JumpHeight1.5x" then
						--	hum.JumpPower *= 1.5
					elseif ability == "Jump Boost" then
						local original = hum.JumpPower

						hum.JumpPower *= 1.5

						char:SetAttribute("abilityDebounce",true)

						repStorage.Remotes.AbilityCooldown:FireClient(plr, lifetime)
					elseif ability == "No Jump" then
						local original = hum.JumpPower

						hum.JumpPower = 0

						char:SetAttribute("abilityDebounce",true)

						repStorage.Remotes.AbilityCooldown:FireClient(plr, lifetime)
					elseif ability == "Long Skewer" then
						LongStick()
					elseif ability == "Summon" then
						Summon()
					elseif ability == "Untouchable" then
						Untouchable()
					else
						ff()
					end
					break
				end
			end

			task.delay(lifetime, function()
				luckyblock:Destroy()
				loop:Disconnect()
				luckyblock:Destroy()

				char:SetAttribute("abilityDebounce",false)

				hum.WalkSpeed = speed
				hum.JumpPower = jump
			end)
		end,

		Choke = function(char, info, plr, look)

			local function nearestplayer()
				local closestChar = nil
				local closestDistance = math.huge
				local origin = char:GetPivot().Position

				for _, Char in workspace:GetChildren() do
					if Char:IsA("Model") and Char:FindFirstChildOfClass("Humanoid") and Char.Humanoid.Health > 0 and Char ~= char and Char:GetAttribute("SafeZone") == false then
						local dist = (origin - Char:GetPivot().Position).Magnitude
						if dist < closestDistance and dist <= 30 then
							closestDistance = dist
							closestChar = Char
						end
					end
				end

				return closestChar
			end
			local target = nearestplayer()

			if not target then 
				char:SetAttribute("abilityDebounce", false)
				return
			end

			local targethum = target.Humanoid

			local prevspeed = targethum.WalkSpeed
			local prevjump = targethum.JumpPower

			targethum.WalkSpeed = 0
			targethum.UseJumpPower = true
			targethum.JumpPower = 0

			local rootattachment = Instance.new("Attachment")
			rootattachment.Parent = target.HumanoidRootPart

			local alignpos = Instance.new("AlignPosition")
			alignpos.Mode = Enum.PositionAlignmentMode.OneAttachment
			alignpos.Attachment0 = rootattachment
			alignpos.Parent = char.HumanoidRootPart
			alignpos.Position = target.HumanoidRootPart.Position + Vector3.new(0,6,0)

			task.delay(2,function()
				if target then
					repStorage.Remotes.ForceKebab:Fire(char,target,plr)
				end
				if alignpos then alignpos:Destroy() end
				if rootattachment then rootattachment:Destroy() end
				if targethum then
					targethum.WalkSpeed = prevspeed
					targethum.UseJumpPower = true
					targethum.JumpPower = prevjump
				end
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

			task.delay(info.Cooldown,function()
				char:SetAttribute("abilityDebounce", false)
			end)
		end,

		Beans = function(char, info, plr, look)
			repStorage.Remotes.Beans:FireClient(plr)
			local ts = game:GetService("TweenService")
			local debris = game:GetService("Debris")
			local rs = game:GetService("RunService")
			local function fireProjectile(player, origin, direction)
				local boltSpeed = 300
				local lifetime = 5
				local gravity = Vector3.new(0, -50, 0)

				local bolt = Instance.new("Part")
				bolt.Size = Vector3.new(0.3, 0.3, 1.5)
				bolt.Material = Enum.Material.Neon
				bolt.BrickColor = BrickColor.new("Really red")
				bolt.Anchored = true
				bolt.CanCollide = false
				bolt.CFrame = CFrame.new(origin, origin + direction)
				bolt.Parent = workspace

				local light = Instance.new("SpotLight")
				light.Brightness = 4
				light.Range = 10
				light.Color = Color3.new(1, 0, 0)
				light.Parent = bolt

				debris:AddItem(bolt, lifetime)

				local velocity = direction.Unit * boltSpeed
				local elapsed = 0

				local connection
				connection = rs.Heartbeat:Connect(function(dt)
					if not bolt or not bolt.Parent then
						connection:Disconnect()
						return
					end

					velocity += gravity * dt
					local nextPos = bolt.Position + velocity * dt

					local rayParams = RaycastParams.new()
					rayParams.FilterDescendantsInstances = {player.Character}
					rayParams.FilterType = Enum.RaycastFilterType.Exclude

					local result = workspace:Raycast(bolt.Position, velocity * dt, rayParams)
					if result then
						local hit = result.Instance
						if hit then
							local humanoid = hit.Parent:FindFirstChild("Humanoid")
							if humanoid then
								game.ReplicatedStorage.Remotes.ForceKebab:Fire(char, humanoid.Parent, plr)
							end
							bolt:Destroy()
							connection:Disconnect()
							return
						end
					end

					bolt.CFrame = CFrame.lookAt(bolt.Position, nextPos)
					bolt.Position = nextPos

					elapsed += dt
					if elapsed >= lifetime then
						bolt:Destroy()
						connection:Disconnect()
					end
				end)
			end

			repStorage.Remotes.Beans.OnServerEvent:Connect(function(player, targetPosition)
				local player = plr
				local origin = char.HumanoidRootPart.Position
				local direction = (targetPosition - origin) 

				fireProjectile(player, origin, direction)

				repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

				task.delay(info.Cooldown,function()
					char:SetAttribute("abilityDebounce", false)
				end)
			end)
		end,

		Whirlwind = function(char,info,plr,look)
			local rs = game:GetService("RunService")

			local tornado = repStorage.Abilitys.TornadoPart:Clone()
			tornado.Parent = workspace
			tornado.Position = char.HumanoidRootPart.Position

			task.wait(2)

			tornado.gust:Play()
			tornado.tornado:Play()

			local hitbox = tornado:FindFirstChild("TornadoHitbox")

			hitbox.Touched:Connect(function(hit)
				if hit.Parent:IsA("Model") and hit.Parent:FindFirstChild("HumanoidRootPart") and not hit.Parent:GetAttribute("InTornado") and hit.Parent ~= char then
					local enemyChar = hit.Parent
					local hrp: Part = enemyChar.HumanoidRootPart
					if not enemyChar:HasTag("Untouchable") and not enemyChar:HasTag("Fortress") then
						enemyChar.IsRagdoll.Value = true
					end
					enemyChar:SetAttribute("InTornado", true)
					enemyChar:SetAttribute("killer", plr.Name)
					allowBurstForCharacter(enemyChar, {
						kind = "tornado_pull",
						duration = 3.5,
						maxDistance = 80,
						allowVertical = true,
						maxHorizontalSpeed = 90,
					})

					enemyChar:PivotTo(tornado:GetPivot())

					local weld = Instance.new("WeldConstraint")
					weld.Part0 = tornado
					weld.Part1 = hrp
					weld.Parent = tornado


					task.delay(3,function()

						weld:Destroy()
						local bodyVelocity = Instance.new("BodyVelocity")
						bodyVelocity.MaxForce = Vector3.new(100000, 100000, 100000)  -- Max force to apply
						local direction = hrp.Position
						bodyVelocity.Velocity = direction/8  -- consistent force magnitude
						bodyVelocity.Parent = hrp
						game.Debris:AddItem(bodyVelocity, 0.2)

						task.delay(2, function()
							if enemyChar then
								enemyChar.IsRagdoll.Value = false
							end
						end)


						task.delay(4,function()
							enemyChar:SetAttribute("killer", nil)
						end)
					end)
				end
			end)

			local nextmovetime = 0
			local connection

			local function GetCF()
				local angle = math.rad(math.random(0,360))
				local distance = 30 * math.random(1,2)
				local direction = Vector3.new(math.cos(angle), 0 ,math.sin(angle))

				local CF = CFrame.new(tornado.Position + direction * distance)

				-- void check

				local Params = RaycastParams.new()
				Params.FilterDescendantsInstances = {tornado,char}
				Params.FilterType = Enum.RaycastFilterType.Exclude

				local Cast = workspace:Raycast(CF.Position, Vector3.new(0,-10,0), Params)

				if not Cast or not Cast.Instance then
					GetCF()
					print("void")
				else
					return CF
				end
			end

			connection = rs.Heartbeat:Connect(function()
				hitbox.Position = tornado.Position
				if tick() >= nextmovetime then


					local CF = GetCF()

					local tween = TweenService:Create(tornado, TweenInfo.new(1,Enum.EasingStyle.Linear), {CFrame = CF})
					tween:Play()


					nextmovetime = tick() + 1
				end
			end)
			task.delay(8,function()
				connection:Disconnect()
				tornado:Destroy()
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.delay(info.Cooldown,function()
				char:SetAttribute("abilityDebounce", false)
			end)
		end,

		Prediction = function(char,info,plr,look)
			local cs = game:GetService("CollectionService")
			local tweens = game:GetService("TweenService")

			char:AddTag("Prediction")
			local highlight = Instance.new("Highlight")
			highlight.Adornee = char
			highlight.Parent = char
			highlight.FillColor = Color3.new(1, 1, 1)
			highlight.OutlineColor = Color3.new(0,0,0)
			highlight.FillTransparency = 0
			highlight.OutlineTransparency = 1
			highlight.DepthMode = "Occluded"


			local tweenfill = tweens:Create(highlight,TweenInfo.new(1,Enum.EasingStyle.Linear,Enum.EasingDirection.In),{FillTransparency = 1})

			tweenfill:Play()
			tweenfill.Completed:Wait()
			char:RemoveTag("Prediction")
			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			highlight:Destroy()

			task.delay(info.Cooldown,function()
				char:SetAttribute("abilityDebounce", false)
			end)
		end,

		digger = function(char, info, plr)
			print("you're gay")
		end,

		Clone = function(char,info,plr)
			local RunService = game:GetService("RunService")
			local hrp = char:FindFirstChild("HumanoidRootPart")
			if not hrp then
				char:SetAttribute("abilityDebounce", false)
				return
			end

			local CLONE_COUNT = 5
			local CLONE_LIFETIME = 8
			local FOLLOW_INTERVAL = 1 / 12 -- 12 Hz follow updates instead of per-frame per-part sync
			local activeClones = {}

			for i = 1, CLONE_COUNT do
				char.Archivable = true
				local clone = char:Clone()
				char.Archivable = false

				clone:AddTag("Clone")

				for _, d in ipairs(clone:GetDescendants()) do
					if d:IsA("Script") or d:IsA("LocalScript") then
						d:Destroy()
					elseif d:IsA("BasePart") then
						d.Anchored = true
						d.CollisionGroup = "Clone"
					end
				end

				local randomoffset = Vector3.new(math.random(-15,15), 0, math.random(-15, 15))
				clone:PivotTo(hrp.CFrame * CFrame.new(randomoffset))
				clone.Parent = workspace
				table.insert(activeClones, {
					model = clone,
					offset = randomoffset
				})

				--vfx
				local cloneHrp = clone:FindFirstChild("HumanoidRootPart")
				if cloneHrp then
					local vfx = game.ReplicatedStorage.VFX.NinjaPoof:Clone()
					vfx.Parent = cloneHrp
					task.delay(0.3, function()
						if vfx and vfx.Parent then
							for _, child in vfx:GetChildren() do
								if child:IsA("ParticleEmitter") then
									child:Emit(10)
								end
							end
						end
					end)
				end

				task.delay(CLONE_LIFETIME,function()
					if clone and clone.Parent then
						clone:Destroy()
					end
				end)

				--local rightArm = clone:FindFirstChild("Right Arm") or clone:FindFirstChild("RightHand")
				--local tool = clone:FindFirstChildWhichIsA("Tool", true)

				--if rightArm and tool and tool:FindFirstChild("Handle") then
				--	local grip = rightArm:FindFirstChild("RightGrip")
				--if grip then grip:Destroy() end
				--
				--	local motor = Instance.new("Motor6D")
				--	motor.Name = "Tool6D"
				--	motor.Part0 = rightArm
				--	motor.Part1 = tool.Handle
				--	motor.C0 = CFrame.new(0, -3, 0)
				--	motor.C1 = CFrame.new()
				--	motor.Parent = rightArm
				--end

			end

			local followElapsed = 0
			local followConn
			followConn = RunService.Heartbeat:Connect(function(dt)
				followElapsed += dt
				if followElapsed < FOLLOW_INTERVAL then
					return
				end
				followElapsed = 0

				if not char or not char.Parent then
					if followConn then
						followConn:Disconnect()
					end
					return
				end

				local ownerHrp = char:FindFirstChild("HumanoidRootPart")
				if not ownerHrp then
					if followConn then
						followConn:Disconnect()
					end
					return
				end

				for idx = #activeClones, 1, -1 do
					local data = activeClones[idx]
					local cloneModel = data and data.model
					if not cloneModel or not cloneModel.Parent then
						table.remove(activeClones, idx)
					else
						cloneModel:PivotTo(ownerHrp.CFrame * CFrame.new(data.offset))
					end
				end

				if #activeClones == 0 and followConn then
					followConn:Disconnect()
				end
			end)

			task.delay(CLONE_LIFETIME + 0.25, function()
				if followConn then
					followConn:Disconnect()
				end
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

			task.delay(info.Cooldown,function()

				char:SetAttribute("abilityDebounce", false)
			end)
		end,

		LVapeMan = function(char,info,plr)
			local boxClass = require(game.ServerStorage.ServerClasses.BoxObject)

			local Vfx = {}

			for _, v in repStorage.Abilitys.SmokeCuboid:GetChildren() do
				local clone = v:Clone()
				table.insert(Vfx,clone)
			end

			local newSmoke = boxClass.new(Vector3.new(10, 15, 25),char:GetPivot(),Vfx,function(...)
				repStorage.Remotes.Bling:FireClient(plr,...)
			end,2,10,workspace.Debris, plr)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

			task.delay(info.Cooldown,function()
				char:SetAttribute("abilityDebounce", false)
			end)
		end,

		Rewind = function(char,info,plr)
			print("activated")
			local history = {}

			local recordinterval = 0.05

			char:SetAttribute("Recording", true)

			for i = 1, 5 / recordinterval do
				local parttable = {}
				for _, part in ipairs(char:GetDescendants()) do
					if part:IsA("BasePart") then
						parttable[part.Name] = part.CFrame
					end
				end
				char:SetAttribute("recordtimer", i * recordinterval)
				table.insert(history,parttable)
				task.wait(recordinterval)
			end
			char:SetAttribute("Recording", false)

			local stoprewind = false

			local backpack = plr:WaitForChild("Backpack")
			local backpackconnection
			backpackconnection = backpack.ChildAdded:Connect(function()
				stoprewind = true
				backpackconnection:Disconnect()
			end)

			for i = #history, 1, -1 do
				if stoprewind then break end
				local moment = history[i]

				for _, part in ipairs(char:GetDescendants()) do
					if part:IsA("BasePart") then
						part.CFrame = moment[part.Name]
					end
				end
				task.wait(recordinterval/4)
			end

			if backpackconnection then
				backpackconnection:Disconnect()
			end


			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

			task.delay(info.Cooldown,function()
				char:SetAttribute("abilityDebounce", false)
			end)
		end,

		Airstrike = function(char,info,plr)
			local plane = repStorage.Abilitys.AirstrikePlane:Clone()
			local root = char.HumanoidRootPart

			local distance = 230

			plane:PivotTo(char.HumanoidRootPart:GetPivot() * CFrame.new(0,30,distance/2))
			plane.Parent = workspace

			local nextbomb = distance / 3

			for i = 1, distance do
				task.wait(0.005)
				plane:PivotTo(plane:GetPivot() * CFrame.new(0,0,-1))

				if i == math.floor(nextbomb) then
					nextbomb += distance / 3

					local bomb = repStorage.Abilitys.airstrikebomb:Clone()
					bomb.Parent = workspace
					bomb.Position = plane.Position + Vector3.new(0,-2,0)
					task.spawn(function()
						local touched = false

						bomb.Touched:Connect(function() end)

						local timeout = 100
						local time = 0

						while not touched do
							if time >= timeout then
								break
							end
							task.wait(0.025)
							time += 1
							bomb.Position = bomb.Position + Vector3.new(0,-1,0)

							local touching = bomb:GetTouchingParts()
							if #touching > 0 then
								touched = true
							end
						end

						local hitbox = game.ReplicatedStorage.Abilitys.Airstrikekillzone:Clone()
						hitbox.Parent = workspace

						local explosion = Instance.new("Explosion")
						explosion.Position = bomb.Position + Vector3.new(0,2.5,0)
						explosion.BlastPressure = 0
						explosion.BlastRadius = 0
						explosion.DestroyJointRadiusPercent = 0
						explosion.Parent = workspace

						hitbox.KillZone.Position = bomb.Position - Vector3.new(0, 2.5, 0)
						hitbox.ShockZone.Position = bomb.Position - Vector3.new(0, 2.5, 0)

						bomb:Destroy()

						game.Debris:AddItem(hitbox.KillZone, 1)
						game.Debris:AddItem(hitbox.ShockZone, 1)
						game.Debris:AddItem(hitbox, 10)


						hitbox.KillZone.Touched:Connect(function(hit)
							if hit.Parent then
								if hit.Parent:FindFirstChild("Humanoid") and hit.Parent ~= char then
									local enemyChar = hit.Parent
									if enemyChar.Humanoid.Health <= 0 then return end
									game.ReplicatedStorage.Remotes.ForceKebab:Fire(char, enemyChar, plr)
								end
							end
						end)

						hitbox.ShockZone.Touched:Connect(function(hit)
							print("a")
							local enemyChar = hit.Parent
							local playerPosition = char:GetPivot().Position
							enemyChar:SetAttribute("killer", plr.Name)
							if enemyChar and enemyChar ~= char and enemyChar:FindFirstChild("HumanoidRootPart")then
								if enemyChar:FindFirstChild("IsRagdoll") and not enemyChar:HasTag("Untouchable") and not enemyChar:HasTag("Fortress") then
									enemyChar.IsRagdoll.Value = true
								end

								local humanoidRootPart = enemyChar:FindFirstChild("HumanoidRootPart")

								local bodyVelocity = Instance.new("BodyVelocity")
								bodyVelocity.MaxForce = Vector3.new(100000, 100000, 100000)  -- Max force to apply
								local direction = (humanoidRootPart.Position - playerPosition).Unit
								bodyVelocity.Velocity = direction * 30  -- consistent force magnitude
								bodyVelocity.Parent = humanoidRootPart
								game.Debris:AddItem(bodyVelocity, 0.2)

								task.delay(2, function()
									if enemyChar then
										enemyChar.IsRagdoll.Value = false
									end
								end)
								task.delay(5,function()
									enemyChar:SetAttribute("killer", nil)
								end)
							end
						end)
					end)
				end
			end
			plane:Destroy()

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

			task.delay(info.Cooldown,function()
				char:SetAttribute("abilityDebounce", false)
			end)
		end,

		Sauce = function(char,info,plr)
			local clicks = char:GetAttribute("sauce")
			local run = game:GetService("RunService")
			local debounce = false
			local hum = char.Humanoid
			local tweeninfo = TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
			local duration = 5

			local ice = storage.Mustard:Clone()
			local ketchup = storage.Ketchup:Clone()

			local currentcolor = nil

			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "squeeze")

			if clicks == true then
				currentcolor = ice
				char:SetAttribute("sauce", false)

			else
				currentcolor = ketchup
				char:SetAttribute("sauce", true)
			end

			local hitbox = currentcolor

			local goal = {}
			goal.Size = Vector3.new(22.5,0.7,22.03)
			local goal2 = {}
			goal2.Size = Vector3.new(22.5, 6.703, 22.03)

			local tween = TweenService:Create(currentcolor,tweeninfo,goal)
			currentcolor.Parent = game.Workspace
			currentcolor.Size = Vector3.new(0,0,0)
			currentcolor.Position = char.HumanoidRootPart.Position + char.HumanoidRootPart.CFrame.LookVector * 5 - Vector3.new(0,2.8,0)
			tween:Play()

			currentcolor.splash:Play()

			hitbox.Touched:Connect(function(hit)
				local enemy = hit.Parent
				local enemyPlr = game.Players:GetPlayerFromCharacter(enemy)
				if enemy:FindFirstChild("Humanoid") and enemy.Name ~= plr.Name and not enemy:GetAttribute("Sauced") then
					enemy.IsRagdoll.Value = true
					enemy:SetAttribute("Sauced", true)
					task.delay(5, function()
						enemy:SetAttribute("Sauced", false)
					end)
					task.delay(3, function()
						enemy.IsRagdoll.Value = false
					end)
				end
			end)

			task.delay(duration, function()
				local goal = {}
				goal.Size = Vector3.new(0,0,0)
				local goal2 = {}
				goal2.Size = Vector3.new(0,0,0)
				local tween = TweenService:Create(currentcolor,tweeninfo,goal)
				local tween0 = TweenService:Create(hitbox,tweeninfo,goal2)
				tween:Play()
				tween0:Play()
				tween.Completed:Wait()
				currentcolor:Destroy()
			end)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		electrify = function(char: Model, info, plr)
			local ShockObj = require(game.ServerStorage.ServerClasses.ShockObject)
			local Shock = repStorage.Abilitys.ElectricShock:Clone()

			Shock.Anchored = true

			Shock:PivotTo(char:GetPivot() * CFrame.new(0,-char.Humanoid.HipHeight,0))
			Shock.Rotation = Vector3.new(0,0,90)

			Shock.Parent = workspace.Debris

			task.delay(2,function()
				Shock:Destroy()
			end)

			local sound = game.SoundService.Electricify:Clone()
			sound.Parent = char.HumanoidRootPart
			sound:Play()

			sound.Ended:Connect(function()
				sound:Destroy()
			end)

			ShockObj.new(char.HumanoidRootPart,25,plr,{char})

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		Antigravity = function(char: Model, info, plr)
			local hrp = char and char:FindFirstChild("HumanoidRootPart")
			if not hrp then
				char:SetAttribute("abilityDebounce", false)
				return
			end

			local radius = tonumber(info.FloatRadius) or 34
			local duration = tonumber(info.FloatDuration) or 5
			local floatHeight = tonumber(info.FloatHeight) or 5
			local center = hrp.Position

			local weaponPart = getWeaponSoundOrigin(char)
			if weaponPart then
				playNamed3DSound(weaponPart, "BassDrop", 3)
			end


			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "Shockwave")

			local pulse = Instance.new("Part")
			pulse.Name = "AntigravityPulse"
			pulse.Shape = Enum.PartType.Ball
			pulse.Anchored = true
			pulse.CanCollide = false
			pulse.CanTouch = false
			pulse.CanQuery = false
			pulse.Material = Enum.Material.ForceField
			pulse.Color = Color3.fromRGB(130, 255, 240)
			pulse.Transparency = 0.3
			pulse.Size = Vector3.new(2, 2, 2)
			pulse.CFrame = CFrame.new(center)
			pulse.Parent = workspace

			local ringTween = TweenService:Create(
				pulse,
				TweenInfo.new(0.45, Enum.EasingStyle.Quart, Enum.EasingDirection.Out),
				{Size = Vector3.new(radius * 2, radius * 2, radius * 2), Transparency = 1}
			)
			ringTween:Play()
			Debris:AddItem(pulse, 0.6)

			local players = game:GetService("Players"):GetPlayers()
			for _, enemyPlr in ipairs(players) do
				local enemyChar = enemyPlr.Character
				if enemyChar and enemyChar ~= char and enemyChar:GetAttribute("SafeZone") == false then
					local enemyHum = enemyChar:FindFirstChildOfClass("Humanoid")
					local enemyRoot = enemyChar:FindFirstChild("HumanoidRootPart")
					if enemyHum and enemyRoot and enemyHum.Health > 0 then
						local distance = (enemyRoot.Position - center).Magnitude
						if distance <= radius then
							local ragdolledByAntigravity = false
							if enemyChar:FindFirstChild("IsRagdoll") and not enemyChar:HasTag("Untouchable") and not enemyChar:HasTag("Fortress") then
								enemyChar.IsRagdoll.Value = true
								ragdolledByAntigravity = true
							end

							local oldWalkSpeed = enemyHum.WalkSpeed
							local oldJumpPower = enemyHum.JumpPower
							local oldAutoRotate = enemyHum.AutoRotate
							local oldAbilityDebounce = enemyChar:GetAttribute("abilityDebounce")
							enemyHum:UnequipTools()
							enemyHum.WalkSpeed = 0
							enemyHum.JumpPower = 0
							enemyHum.AutoRotate = false
							enemyChar:SetAttribute("abilityDebounce", true)

							local disabledTools = {}
							local function disableToolsIn(container)
								if not container then
									return
								end
								for _, item in ipairs(container:GetChildren()) do
									if item:IsA("Tool") then
										disabledTools[item] = item.Enabled
										item.Enabled = false
									end
								end
							end

							disableToolsIn(enemyChar)
							disableToolsIn(enemyPlr:FindFirstChild("Backpack"))

							local antiGrav = Instance.new("BodyPosition")
							antiGrav.Name = "AntigravityFloat"
							antiGrav.MaxForce = Vector3.new(150000, 180000, 150000)
							antiGrav.P = 12000
							antiGrav.D = 850
							antiGrav.Position = enemyRoot.Position + Vector3.new(0, floatHeight, 0)
							antiGrav.Parent = enemyRoot
							Debris:AddItem(antiGrav, duration)

							local spin = Instance.new("BodyAngularVelocity")
							spin.Name = "AntigravitySpin"
							spin.MaxTorque = Vector3.new(0, 9000, 0)
							spin.AngularVelocity = Vector3.new(0, 4.5, 0)
							spin.Parent = enemyRoot
							Debris:AddItem(spin, duration)

							local attach = Instance.new("Attachment")
							attach.Name = "AntigravityVFX"
							attach.Parent = enemyRoot
							Debris:AddItem(attach, duration)

							local aura = Instance.new("ParticleEmitter")
							aura.Name = "AntigravityAura"
							aura.Texture = "rbxasset://textures/particles/sparkles_main.dds"
							aura.Rate = 70
							aura.Lifetime = NumberRange.new(0.45, 0.75)
							aura.Speed = NumberRange.new(1.5, 5)
							aura.Acceleration = Vector3.new(0, 6, 0)
							aura.SpreadAngle = Vector2.new(360, 360)
							aura.LightEmission = 1
							aura.Size = NumberSequence.new({
								NumberSequenceKeypoint.new(0, 0.25),
								NumberSequenceKeypoint.new(0.6, 0.45),
								NumberSequenceKeypoint.new(1, 0)
							})
							aura.Color = ColorSequence.new(
								Color3.fromRGB(146, 255, 237),
								Color3.fromRGB(188, 231, 255)
							)
							aura.Parent = attach
							Debris:AddItem(aura, duration)

							task.delay(duration, function()
								if enemyHum and enemyHum.Parent then
									enemyHum.WalkSpeed = oldWalkSpeed
									enemyHum.JumpPower = oldJumpPower
									enemyHum.AutoRotate = oldAutoRotate
								end

								if enemyChar and enemyChar.Parent then
									enemyChar:SetAttribute("abilityDebounce", oldAbilityDebounce == true)
								end

								for tool, wasEnabled in pairs(disabledTools) do
									if tool and tool.Parent then
										tool.Enabled = wasEnabled
									end
								end

								if ragdolledByAntigravity and enemyChar and enemyChar.Parent and enemyChar:FindFirstChild("IsRagdoll") then
									enemyChar.IsRagdoll.Value = false
								end
							end)
						end
					end
				end
			end

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		RailRush = function(char: Model, info, plr, look)
			local RailRushTrain = require(game.ServerStorage.ServerClasses.RailRush)

			local hrp = char:FindFirstChild("HumanoidRootPart")
			local direction = (look and look.Magnitude > 0) and look.Unit or (hrp and hrp.CFrame.LookVector) or Vector3.new(0, 0, -1)

			RailRushTrain.new(char, plr, direction)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		SantaRush = function(char: Model, info, plr, look)
			local SantaRush = require(game.ServerStorage.ServerClasses.SantaRush)

			local hrp = char:FindFirstChild("HumanoidRootPart")
			local direction = (look and look.Magnitude > 0) and look.Unit or (hrp and hrp.CFrame.LookVector) or Vector3.new(0, 0, -1)

			local spawnCount = info.SpawnCount or 3
			SantaRush.new(char, plr, direction, spawnCount)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		Train = function(char: Model, info, plr)
			local TrainObj = require(game.ServerStorage.ServerClasses.Train)

			TrainObj.new(char:GetPivot(), char, plr)

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce",false)
		end,

		FireworkRain = function(char: Model, info, plr, look)
			local hrp = char and char:FindFirstChild("HumanoidRootPart")
			local hum = char and char:FindFirstChildOfClass("Humanoid")
			if not (hrp and hum and hum.Health > 0 and plr) then
				if char then char:SetAttribute("abilityDebounce", false) end
				return
			end

			-- ===== TUNING =====
			local ROCKET_RISE_HEIGHT = 145
			local ROCKET_RISE_TIME = 1.15
			local SPIRAL_TURNS = 10
			local SPIRAL_RADIUS_START = 2
			local SPIRAL_RADIUS_END = 4.5

			local BRICK_COUNT = 36
			local SPREAD_RADIUS = 24
			local BRICK_LIFETIME = 2.6
			local BRICK_SIZE_MIN = 1.2
			local BRICK_SIZE_MAX = 2.2
			local BRICK_FALL_SPEED = 80

			local KILL_DEBOUNCE_PER_BRICK = true

			-- ===== ORIGIN (from tool handle if possible) =====
			local tool = char:FindFirstChildOfClass("Tool")
			local origin = hrp.Position + Vector3.new(0, 2.5, 0)

			if tool and tool:FindFirstChild("Handle") and tool.Handle:IsA("BasePart") then
				origin = tool.Handle.Position + Vector3.new(0, 1.5, 0)
			end

			-- Fire cooldown UI immediately (like your other abilities)
			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

			-- ===== SPAWN FIREWORK MODEL =====
			local fireworkTemplate = storage:FindFirstChild("Firework")
			if not fireworkTemplate then
				warn("Missing ReplicatedStorage.Abilitys.Firework model")
				task.wait(info.Cooldown)
				char:SetAttribute("abilityDebounce", false)
				return
			end

			local firework = fireworkTemplate:Clone()
			firework.Parent = workspace

			-- Pick a root part for pivoting
			local fwRoot = firework.PrimaryPart
			if not fwRoot then
				fwRoot = firework:FindFirstChildWhichIsA("BasePart", true)
			end
			if not fwRoot then
				firework:Destroy()
				task.wait(info.Cooldown)
				char:SetAttribute("abilityDebounce", false)
				return
			end

			-- Ensure stable movement
			for _, d in ipairs(firework:GetDescendants()) do
				if d:IsA("BasePart") then
					d.Anchored = true
					d.CanCollide = false
					d.CanTouch = false
					d.CanQuery = false
				end
			end

			firework:PivotTo(CFrame.new(origin))

			-- Launch sound (either SoundService.FireworkLaunch OR a Sound named "Launch" inside model)
			local launchSound = firework:FindFirstChild("Launch", true)
			if launchSound and launchSound:IsA("Sound") then
				launchSound:Play()
			else
				playNamed3DSound(fwRoot, "FireworkLaunch", 3)
			end

			-- ===== SPIRAL UP =====
			local startT = os.clock()
			local startPos = origin
			local finished = false
			local apexPos = startPos + Vector3.new(0, ROCKET_RISE_HEIGHT, 0)

			local conn
			conn = RunService.Heartbeat:Connect(function()
				if finished or not firework.Parent then return end

				local t = (os.clock() - startT) / ROCKET_RISE_TIME
				if t >= 1 then
					t = 1
					finished = true
				end

				local height = ROCKET_RISE_HEIGHT * t
				local angle = (SPIRAL_TURNS * 2 * math.pi) * t
				local radius = SPIRAL_RADIUS_START + (SPIRAL_RADIUS_END - SPIRAL_RADIUS_START) * t

				local offset = Vector3.new(math.cos(angle) * radius, height, math.sin(angle) * radius)
				local pos = startPos + offset

				-- face "up" with a bit of spin
				local cf = CFrame.new(pos, pos + Vector3.new(math.cos(angle), 0.35, math.sin(angle)))
				firework:PivotTo(cf)

				if finished then
					apexPos = pos
					if conn then conn:Disconnect() end
				end
			end)

			-- wait until ascent is done
			task.wait(ROCKET_RISE_TIME + 0.02)

			-- ===== EXPLODE =====
			local explodeSound = firework:FindFirstChild("Explode", true)
			if explodeSound and explodeSound:IsA("Sound") then
				explodeSound:Play()
			else
				playNamed3DSound(fwRoot, "FireworkExplode", 3)
			end

			-- emit any particles inside the firework model (optional)
			for _, thing in ipairs(firework:GetDescendants()) do
				if thing:IsA("ParticleEmitter") then
					thing:Emit(25)
				end
			end

			-- remove the rocket body shortly after explosion
			Debris:AddItem(firework, 0.4)

			-- ===== RAIN KILL BRICKS =====
			local colors = {
				Color3.fromRGB(255, 70, 70),
				Color3.fromRGB(70, 255, 120),
				Color3.fromRGB(70, 170, 255),
				Color3.fromRGB(255, 235, 70),
				Color3.fromRGB(200, 70, 255),
				Color3.fromRGB(255, 140, 70),
				Color3.fromRGB(70, 255, 255),
			}

			local function makeBrick()
				local p = Instance.new("Part")
				p.Name = "FireworkKillBrick"
				p.Material = Enum.Material.Neon
				p.Color = colors[math.random(1, #colors)]
				p.Anchored = false
				p.CanCollide = false
				p.CanTouch = true
				p.CanQuery = false
				p.Massless = false

				local sx = math.random() * (BRICK_SIZE_MAX - BRICK_SIZE_MIN) + BRICK_SIZE_MIN
				local sy = math.random() * (BRICK_SIZE_MAX - BRICK_SIZE_MIN) + BRICK_SIZE_MIN
				local sz = math.random() * (BRICK_SIZE_MAX - BRICK_SIZE_MIN) + BRICK_SIZE_MIN
				p.Size = Vector3.new(sx, sy, sz)

				p.Parent = workspace
				return p
			end

			for i = 1, BRICK_COUNT do
				local brick = makeBrick()

				local angle = math.random() * math.pi * 2
				local r = math.random() * SPREAD_RADIUS
				local x = math.cos(angle) * r
				local z = math.sin(angle) * r

				brick.CFrame = CFrame.new(apexPos + Vector3.new(x, 0, z))

				-- give it a downward + slight outward velocity
				local bv = Instance.new("BodyVelocity")
				bv.MaxForce = Vector3.new(1e5, 1e5, 1e5)
				bv.P = 1e5
				bv.Velocity = Vector3.new(x, -BRICK_FALL_SPEED, z) * 0.5
				bv.Parent = brick
				Debris:AddItem(bv, 0.15)

				-- brick "whistle" sound (SoundService.FireworkBrick OR put a Sound in SoundService with that name)
				playNamed3DSound(brick, "FireworkBrick", 2)

				local brickDebounce = false
				local landed = false
				local touchConn

				touchConn = brick.Touched:Connect(function(hit)
					if not hit or not hit.Parent then return end
					if hit:IsDescendantOf(char) then return end

					-- ===== LAND SOUND (non-character touch) =====
					if not landed then
						-- Ignore other firework bricks so they don't spam land sounds
						if hit.Name ~= "FireworkKillBrick" then
							local m = hit:FindFirstAncestorOfClass("Model")
							local h = m and m:FindFirstChildOfClass("Humanoid")

							-- If it's NOT a character, treat it as "ground" and play land once
							if not h then
								landed = true
								playNamed3DSound(brick, "FireworkLand", 3)
							end
						end
					end

					-- ===== KILL LOGIC (character touch) =====
					local enemyChar = hit:FindFirstAncestorOfClass("Model")
					if not enemyChar or enemyChar == char then return end
					if enemyChar:GetAttribute("SafeZone") == true then return end

					local enemyHum = enemyChar:FindFirstChildOfClass("Humanoid")
					if not enemyHum or enemyHum.Health <= 0 then return end

					if KILL_DEBOUNCE_PER_BRICK then
						if brickDebounce then return end
						brickDebounce = true
					end

					enemyChar:SetAttribute("killer", plr.Name)
					repStorage.Remotes.ForceKebab:Fire(char, enemyChar, plr)

					if touchConn then touchConn:Disconnect() end
					brick:Destroy()
				end)


				Debris:AddItem(brick, BRICK_LIFETIME)
				task.delay(BRICK_LIFETIME, function()
					if touchConn then touchConn:Disconnect() end
				end)

				task.wait(0.02) -- slight stagger looks better
			end

			-- ===== COOLDOWN / DEBOUNCE RESET (matches your pattern) =====
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce", false)
		end,

		BananaPeel = function(char: Model, info, plr, look)
			local humanoid = char and char:FindFirstChildOfClass("Humanoid")
			local hrp = char and char:FindFirstChild("HumanoidRootPart")
			local tool = char and char:FindFirstChildOfClass("Tool")
			if not (char and humanoid and hrp and humanoid.Health > 0 and plr and tool and tool.Parent == char and BananaProjectileClass) then
				if char then
					char:SetAttribute("abilityDebounce", false)
				end
				return
			end

			if char:GetAttribute("BananaCooldownActive") then
				char:SetAttribute("abilityDebounce", false)
				return
			end

			ensureBananaCleanupHooks(char)

			local charges = math.max(1, math.floor(tonumber(info.Charges) or 3))
			local remaining = char:GetAttribute("BananaPeelsRemaining")
			if type(remaining) ~= "number" or remaining < 0 or remaining > charges then
				remaining = charges
			end

			if remaining <= 0 then
				char:SetAttribute("abilityDebounce", false)
				return
			end

			local throwDirection = (look and look.Magnitude > 0) and look.Unit or hrp.CFrame.LookVector
			local origin = resolveBananaThrowOrigin(char, tool, throwDirection)

			BananaProjectileClass.new({
				ownerChar = char,
				ownerPlayer = plr,
				origin = origin,
				direction = throwDirection,
				speed = tonumber(info.ThrowSpeed) or 50,
				upwardVelocity = tonumber(info.ThrowUpwardVelocity) or 20,
				projectileRadius = tonumber(info.ProjectileRadius) or 1.1,
				maxFlightTime = tonumber(info.MaxFlightTime) or 1.35,
				trapLifetime = tonumber(info.PeelLifetime) or 8,
				trapRadius = tonumber(info.TrapRadius) or 3.25,
				trapPollInterval = tonumber(info.TrapPollInterval) or 0.05,
				ragdollDuration = tonumber(info.SlipRagdollDuration) or 1.25,
				knockbackStrength = tonumber(info.SlipKnockbackStrength) or 35,
			})

			local remainingAfterThrow = remaining - 1
			char:SetAttribute("BananaPeelsRemaining", remainingAfterThrow)

			if remainingAfterThrow <= 0 then
				local cooldown = tonumber(info.Cooldown) or 10
				char:SetAttribute("BananaCooldownActive", true)
				repStorage.Remotes.AbilityCooldown:FireClient(plr, cooldown)

				task.delay(cooldown, function()
					if not (char and char.Parent) then
						return
					end

					if not char:GetAttribute("BananaCooldownActive") then
						return
					end

					char:SetAttribute("BananaPeelsRemaining", charges)
					char:SetAttribute("BananaCooldownActive", false)
					char:SetAttribute("abilityDebounce", false)
				end)

				return
			end

			task.delay(0.2, function()
				if char and char.Parent and not char:GetAttribute("BananaCooldownActive") then
					char:SetAttribute("abilityDebounce", false)
				end
			end)
		end,


		ChainArrow = function(char: Model, info, plr, look)
			local hum = char and char:FindFirstChildOfClass("Humanoid")
			local hrp = char and char:FindFirstChild("HumanoidRootPart")
			local tool = char and char:FindFirstChildOfClass("Tool")
			if not (char and hum and hrp and hum.Health > 0 and plr and tool) then
				if char then
					char:SetAttribute("abilityDebounce", false)
				end
				return
			end

			local Players = game:GetService("Players")
			local debrisParent = workspace:FindFirstChild("Debris") or workspace
			local maxHits = math.max(1, math.floor(tonumber(info.ChainHits) or 5))
			local chainRange = tonumber(info.ChainRange) or 24
			local arrowRange = tonumber(info.ArrowRange) or 170
			local arrowRadius = tonumber(info.ArrowRadius) or 1.2
			local chainDelay = tonumber(info.ChainDelay) or 0.08
			local baseLook = (look and look.Magnitude > 0) and look.Unit or hrp.CFrame.LookVector

			local origin = hrp.Position + Vector3.new(0, 1.8, 0)
			local shootPoint = nil
			for _, descendant in ipairs(tool:GetDescendants()) do
				if descendant:IsA("Attachment") and descendant.Name == "ShootPoint" then
					shootPoint = descendant
					break
				end
			end

			if shootPoint then
				local parentPart = shootPoint.Parent
				if parentPart and parentPart:IsA("BasePart") then
					origin = parentPart.CFrame:PointToWorldSpace(shootPoint.Position)
				else
					origin = shootPoint.WorldPosition
				end
			elseif tool:FindFirstChild("Handle") and tool.Handle:IsA("BasePart") then
				origin = tool.Handle.Position + baseLook * 1.5 + Vector3.new(0, 0.2, 0)
			end

			local function spawnSegment(fromPos: Vector3, toPos: Vector3, color: Color3, thickness: number, life: number)
				local distance = (toPos - fromPos).Magnitude
				if distance < 0.05 then
					return
				end

				local segment = Instance.new("Part")
				segment.Name = "ChainArrowSegment"
				segment.Anchored = true
				segment.CanCollide = false
				segment.CanTouch = false
				segment.CanQuery = false
				segment.Material = Enum.Material.Neon
				segment.Color = color
				segment.Transparency = 0.1
				segment.Size = Vector3.new(thickness, thickness, distance)
				segment.CFrame = CFrame.lookAt(fromPos, toPos) * CFrame.new(0, 0, -distance * 0.5)
				segment.Parent = debrisParent

				local light = Instance.new("PointLight")
				light.Color = color
				light.Brightness = 2.5
				light.Range = math.clamp(distance * 0.25, 7, 18)
				light.Parent = segment

				local tween = TweenService:Create(
					segment,
					TweenInfo.new(life, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
					{Transparency = 1}
				)
				tween:Play()

				Debris:AddItem(segment, life + 0.05)
			end

			local function spawnImpact(pos: Vector3, color: Color3, size: number)
				local orb = Instance.new("Part")
				orb.Name = "ChainArrowImpact"
				orb.Shape = Enum.PartType.Ball
				orb.Material = Enum.Material.Neon
				orb.Color = color
				orb.Anchored = true
				orb.CanCollide = false
				orb.CanTouch = false
				orb.CanQuery = false
				orb.Transparency = 0.15
				orb.Size = Vector3.new(size, size, size)
				orb.CFrame = CFrame.new(pos)
				orb.Parent = debrisParent

				local flash = Instance.new("PointLight")
				flash.Color = color
				flash.Range = 10
				flash.Brightness = 4
				flash.Parent = orb

				local fade = TweenService:Create(
					orb,
					TweenInfo.new(0.2, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
					{Transparency = 1, Size = orb.Size * 2}
				)
				fade:Play()

				Debris:AddItem(orb, 0.25)
			end

			local function getHumanoidModelFromInstance(inst: Instance?)
				if not (inst and inst.Parent) then
					return nil
				end
				local model = inst:FindFirstAncestorOfClass("Model")
				if model and model:FindFirstChildOfClass("Humanoid") then
					return model
				end
				return nil
			end

			local function isValidEnemy(enemyChar: Model?): boolean
				if not enemyChar or enemyChar == char then
					return false
				end

				local enemyHum = enemyChar:FindFirstChildOfClass("Humanoid")
				local enemyRoot = enemyChar:FindFirstChild("HumanoidRootPart")
				if not (enemyHum and enemyRoot and enemyHum.Health > 0) then
					return false
				end

				if enemyChar:GetAttribute("SafeZone") == true then
					return false
				end

				if enemyChar:GetAttribute("InDimension") then
					return false
				end

				return true
			end

			local function findClosestNextTarget(currentChar: Model, alreadyHit: {[Model]: boolean})
				local currentRoot = currentChar:FindFirstChild("HumanoidRootPart")
				if not currentRoot then
					return nil
				end

				local bestTarget = nil
				local bestDist = nil

				for _, enemyPlr in ipairs(Players:GetPlayers()) do
					local enemyChar = enemyPlr.Character
					if enemyChar and not alreadyHit[enemyChar] and isValidEnemy(enemyChar) then
						local enemyRoot = enemyChar:FindFirstChild("HumanoidRootPart")
						if enemyRoot then
							local dist = (enemyRoot.Position - currentRoot.Position).Magnitude
							if dist <= chainRange and (not bestDist or dist < bestDist) then
								bestDist = dist
								bestTarget = enemyChar
							end
						end
					end
				end

				return bestTarget
			end

			local function fallbackFirstTarget(rayParams: RaycastParams)
				local bestTarget = nil
				local bestDist = nil
				local minDot = math.cos(math.rad(11))

				for _, enemyPlr in ipairs(Players:GetPlayers()) do
					local enemyChar = enemyPlr.Character
					if isValidEnemy(enemyChar) then
						local enemyRoot = enemyChar and enemyChar:FindFirstChild("HumanoidRootPart")
						if enemyRoot then
							local offset = enemyRoot.Position - origin
							local dist = offset.Magnitude
							if dist <= arrowRange then
								local dir = (dist > 0) and offset.Unit or baseLook
								if dir:Dot(baseLook) >= minDot then
									local block = workspace:Raycast(origin, dir * dist, rayParams)
									if (not block) or block.Instance:IsDescendantOf(enemyChar) then
										if not bestDist or dist < bestDist then
											bestDist = dist
											bestTarget = enemyChar
										end
									end
								end
							end
						end
					end
				end

				return bestTarget
			end

			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "Shotgun")
			local soundOrigin = tool:FindFirstChild("Handle")
			if not (soundOrigin and soundOrigin:IsA("BasePart")) then
				soundOrigin = hrp
			end
			playNamed3DSound(soundOrigin, "Electricify", 2)
			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)

			local rayParams = RaycastParams.new()
			rayParams.FilterType = Enum.RaycastFilterType.Exclude
			rayParams.FilterDescendantsInstances = {char}

			local firstResult = workspace:Spherecast(origin, arrowRadius, baseLook * arrowRange, rayParams)
			local firstTarget = nil
			local arrowEndPos = origin + baseLook * arrowRange

			if firstResult then
				arrowEndPos = firstResult.Position
				local candidate = getHumanoidModelFromInstance(firstResult.Instance)
				if candidate and isValidEnemy(candidate) then
					firstTarget = candidate
				end
			end

			if not firstTarget then
				firstTarget = fallbackFirstTarget(rayParams)
				if firstTarget and firstTarget:FindFirstChild("HumanoidRootPart") then
					arrowEndPos = firstTarget.HumanoidRootPart.Position + Vector3.new(0, 1.5, 0)
				end
			end

			spawnImpact(origin + baseLook * 1.4, Color3.fromRGB(255, 230, 140), 0.7)
			spawnSegment(origin, arrowEndPos, Color3.fromRGB(255, 214, 99), 0.4, 0.18)

			if firstTarget then
				local alreadyHit: {[Model]: boolean} = {}
				local linkColors = {
					Color3.fromRGB(111, 220, 255),
					Color3.fromRGB(151, 255, 200),
					Color3.fromRGB(212, 183, 255),
					Color3.fromRGB(255, 235, 132),
				}

				local current = firstTarget
				local prevPoint = arrowEndPos
				local hop = 0

				while current and hop < maxHits do
					local currentRoot = current:FindFirstChild("HumanoidRootPart")
					if not currentRoot then
						break
					end

					local hitPos = currentRoot.Position + Vector3.new(0, 1.4, 0)
					local color = linkColors[(hop % #linkColors) + 1]

					spawnSegment(prevPoint, hitPos, color, 0.34, 0.2)
					spawnImpact(hitPos, color, 0.85)

					alreadyHit[current] = true
					current:SetAttribute("killer", plr.Name)
					repStorage.Remotes.ForceKebab:Fire(char, current, plr)

					hop += 1
					if hop >= maxHits then
						break
					end

					local nextTarget = findClosestNextTarget(current, alreadyHit)
					prevPoint = hitPos
					current = nextTarget

					if current then
						task.wait(chainDelay)
					end
				end
			end

			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce", false)
		end,


		Shotgun = function(char: Model, info, plr, look)
			local DEBUG_SHOTGUN = true
			local DEBUG_DURATION = 2
			local PELLET_COUNT = 8
			local SPREAD_ANGLE = 15
			local RANGE = 50
			local SHAPECAST_RADIUS = 0.5

			local tool = char:FindFirstChildOfClass("Tool")
			local origin
			local shootPoint = nil

			if tool then
				for _, descendant in pairs(tool:GetDescendants()) do
					if descendant.Name == "ShootPoint" and descendant:IsA("Attachment") then
						shootPoint = descendant
						break
					end
				end
			end

			if shootPoint then
				local parentPart = shootPoint.Parent
				if parentPart:IsA("BasePart") then
					origin = parentPart.CFrame:PointToWorldSpace(shootPoint.Position)
				else
					origin = shootPoint.WorldPosition
				end
			elseif tool and tool:FindFirstChild("Handle") then
				origin = tool.Handle.Position + Vector3.new(0, 0, -1)
			else
				origin = char.HumanoidRootPart.Position + Vector3.new(0, 0.5, 0)
			end

			local hitPlayers = {}

			game.ReplicatedStorage.Remotes.Sound:FireClient(plr, "Shotgun")

			local muzzleFlash = Instance.new("Part")
			muzzleFlash.Size = Vector3.new(1, 1, 1)
			muzzleFlash.Transparency = 0.5
			muzzleFlash.Material = Enum.Material.Neon
			muzzleFlash.Color = Color3.fromRGB(255, 200, 50)
			muzzleFlash.Anchored = true
			muzzleFlash.CanCollide = false
			muzzleFlash.CanQuery = false
			muzzleFlash.CFrame = CFrame.new(origin + look * 2)
			muzzleFlash.Parent = workspace.Debris

			local flash = Instance.new("PointLight")
			flash.Brightness = 5
			flash.Range = 15
			flash.Color = Color3.fromRGB(255, 200, 50)
			flash.Parent = muzzleFlash

			game.Debris:AddItem(muzzleFlash, 0.1)

			local shapecastParams = RaycastParams.new()
			shapecastParams.FilterDescendantsInstances = {char}
			shapecastParams.FilterType = Enum.RaycastFilterType.Exclude

			for i = 1, PELLET_COUNT do
				local horizontalSpread = math.rad((math.random() - 0.5) * 2 * SPREAD_ANGLE)
				local verticalSpread = math.rad((math.random() - 0.5) * 2 * SPREAD_ANGLE)

				local spreadDirection = CFrame.new(Vector3.zero, look)
					* CFrame.Angles(verticalSpread, horizontalSpread, 0)
				local pelletDirection = spreadDirection.LookVector

				local result = workspace:Spherecast(origin, SHAPECAST_RADIUS, pelletDirection * RANGE, shapecastParams)
				local endPosition = origin + pelletDirection * RANGE

				if result then
					endPosition = result.Position
					local hit = result.Instance
					local enemyChar = hit.Parent

					if enemyChar:IsA("Accessory") then
						enemyChar = enemyChar.Parent
					end

					if enemyChar:FindFirstChild("Humanoid") and enemyChar ~= char then
						if not hitPlayers[enemyChar] then
							hitPlayers[enemyChar] = true
							repStorage.Remotes.ForceKebab:Fire(char, enemyChar, plr)
						end
					end
				end

				if DEBUG_SHOTGUN then
					local trailThickness = SHAPECAST_RADIUS / 2
					local trailPart = Instance.new("Part")
					trailPart.Size = Vector3.new(trailThickness, trailThickness, (endPosition - origin).Magnitude)
					trailPart.Anchored = true
					trailPart.CanCollide = false
					trailPart.CanQuery = false
					trailPart.Transparency = 0.3
					trailPart.Material = Enum.Material.Neon
					trailPart.Color = Color3.fromRGB(255, 0, 0)
					trailPart.CFrame = CFrame.lookAt(origin, endPosition) * CFrame.new(0, 0, -trailPart.Size.Z / 2)
					trailPart.Parent = workspace.Debris

					local tweenInfo = TweenInfo.new(DEBUG_DURATION, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
					local tween = TweenService:Create(trailPart, tweenInfo, {Transparency = 1})
					tween:Play()

					game.Debris:AddItem(trailPart, DEBUG_DURATION)
				end
			end

			repStorage.Remotes.AbilityCooldown:FireClient(plr, info.Cooldown)
			task.wait(info.Cooldown)
			char:SetAttribute("abilityDebounce", false)
		end,
	}


}

return module
