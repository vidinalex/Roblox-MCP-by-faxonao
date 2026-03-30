--// Delete Garbage
local garbage = game.Workspace:FindFirstChild("Garbage")
if garbage then
	garbage:Destroy()
end
--//

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local Aether = require(ReplicatedStorage:WaitForChild("Aether"))

local function tagAetherLibrary(moduleScript: Instance?)
	if moduleScript ~= nil and moduleScript:IsA("ModuleScript") then
		CollectionService:AddTag(moduleScript, "AE_Library")
	end
end

--// Prewarm remotes
Aether:GetRemoteEvent("QuestService_GetRewardByQuest")
Aether:GetRemoteFunction("GiftService_GetState")
Aether:GetRemoteFunction("GiftService_ClaimGift")
Aether:GetRemoteFunction("BattlePassService_GetState")
Aether:GetRemoteFunction("BattlePassService_ClaimReward")
Aether:GetRemoteFunction("RespawnService_GetState")
Aether:GetRemoteFunction("RespawnService_PrepareSaveShipPurchase")
Aether:GetRemoteEvent("RespawnService_StateChanged")

local worldGenInit = Aether:LoadLibrary("WorldGenerationInit")
if typeof(worldGenInit) == "table" and typeof(worldGenInit.Init) == "function" then
	worldGenInit.Init()
end

local weaponInit = Aether:LoadLibrary("WeaponInit")
if typeof(weaponInit) == "table" and typeof(weaponInit.Init) == "function" then
	weaponInit.Init()
end

local BotInit = require(game.ServerScriptService.Mechanics.Bots.Server.BotInit)
if typeof(BotInit) == "table" and typeof(BotInit.Init) == "function" then
	BotInit.Init()
end

local propManagerServer = Aether:LoadLibrary("PropManagerServer")
local badgeJoinManagerServer = Aether:LoadLibrary("BadgeJoinManagerServer")

local AdminPanelService = Aether:LoadLibrary("AdminPanelService")
if typeof(AdminPanelService) == "table" and typeof(AdminPanelService.Init) == "function" then
	AdminPanelService.Init()
end

local questManagerServer = Aether:LoadLibrary("QuestManagerServer")
assert(questManagerServer, "QuestManagerServer not found")
local giftManagerServer = Aether:LoadLibrary("GiftManagerServer")
assert(giftManagerServer, "GiftManagerServer not found")
local battlePassManagerServer = Aether:LoadLibrary("BattlePassManagerServer")
assert(battlePassManagerServer, "BattlePassManagerServer not found")
local questEventsManager = Aether:LoadLibrary("QuestEventsManager")
local UserDataService = Aether:LoadLibrary("UserDataService")

local relicManager = Aether:LoadLibrary("RelicManagerServer")
local captainsManager = Aether:LoadLibrary("CaptainsManagerServer")
local captainsModule = Aether:LoadLibrary("CaptainsModule")

local notificationManager = Aether:LoadLibrary("NotificationManagerServer")
local lootboxManagerServer = Aether:LoadLibrary("LootboxManagerServer")
local shopManagerServer = Aether:LoadLibrary("ShopManagerServer")
local gameEventManager = Aether:LoadLibrary("GameEventsManagerServer")
local krakenManager = Aether:LoadLibrary("KrakenManagerServer")
local fruitsManager = Aether:LoadLibrary("FruitsManagerServer")
local abilityManagerServer = Aether:LoadLibrary("AbilityManagerServer")
local aurasManagerServer = Aether:LoadLibrary("AurasManagerServer")
local repulsionWaveManagerServer = Aether:LoadLibrary("RepulsionWaveManagerServer")
local weaponRouletteManagerServer = Aether:LoadLibrary("WeaponRouletteManagerServer")
local MonetizationManagerServer = require(game.ServerScriptService.Mechanics.Monetization.Server.MonetizationManagerServer)
local BoatManagerServer = require(game.ServerScriptService.Mechanics.Boat.Server.BoatManagerServer)
local MonetizationBuffsServer = require(game.ServerScriptService.Mechanics.Monetization.Server.MonetizationBuffsServer)
local BoatProgressionFunnelServer = require(game.ServerScriptService.Mechanics.Analytics.Server.BoatProgressionFunnelServer)

if typeof(battlePassManagerServer) == "table" and typeof((battlePassManagerServer :: any).Init) == "function" then
	(battlePassManagerServer :: any).Init()
end
if typeof(MonetizationManagerServer) == "table" and typeof(MonetizationManagerServer.Init) == "function" then
	MonetizationManagerServer.Init()
end
if typeof(MonetizationBuffsServer) == "table" and typeof(MonetizationBuffsServer.Init) == "function" then
	MonetizationBuffsServer.Init()
end
if typeof(BoatProgressionFunnelServer) == "table" and typeof(BoatProgressionFunnelServer.Init) == "function" then
	BoatProgressionFunnelServer.Init()
end

local settingsManagerServer = Aether:LoadLibrary("SettingsManagerServer")

local tutorialService = Aether:LoadLibrary("TutorialService")
if tutorialService == nil then
	local okDirect, directOrErr = pcall(function()
		return require(game.ServerScriptService.Mechanics.Tutorial.Server.TutorialService)
	end)
	if okDirect then
		tutorialService = directOrErr
	else
		warn("[Init_Server] TutorialService not loaded:", directOrErr)
	end
end
if typeof(tutorialService) == "table" and typeof(tutorialService.Init) == "function" then
	tutorialService.Init()
end

--// Session leaderboard (default Roblox leaderstats)
do
	local function ensureKillsValue(player: Player): IntValue?
		if typeof(player) ~= "Instance" or not player:IsA("Player") then
			return nil
		end

		local leaderstats = player:FindFirstChild("leaderstats")
		if leaderstats == nil then
			leaderstats = Instance.new("Folder")
			leaderstats.Name = "leaderstats"
			leaderstats.Parent = player
		end

		local kills = leaderstats:FindFirstChild("Kills")
		if kills ~= nil and kills:IsA("IntValue") then
			return kills
		end

		if kills ~= nil then
			kills:Destroy()
		end

		local created = Instance.new("IntValue")
		created.Name = "Kills"
		created.Value = 0
		created.Parent = leaderstats
		return created
	end

	Players.PlayerAdded:Connect(function(player: Player)
		ensureKillsValue(player)
	end)

	for _, player: Player in ipairs(Players:GetPlayers()) do
		task.spawn(ensureKillsValue, player)
	end

	if typeof(questEventsManager) == "table"
		and typeof((questEventsManager :: any).events) == "table"
		and (questEventsManager :: any).events.KillEnemy ~= nil
	then
		(questEventsManager :: any).events.KillEnemy:Connect(function(player: Player, eventInfo: any?)
			if typeof(player) ~= "Instance" or not player:IsA("Player") then
				return
			end

			if typeof(eventInfo) == "table" then
				local targetUserId = tonumber(eventInfo.targetUserId)
				if targetUserId ~= nil and targetUserId == player.UserId then
					return
				end
			end

			local kills = ensureKillsValue(player)
			if kills ~= nil then
				kills.Value += 1
			end
		end)
	end
end
--//

--// Crown for top progression player
do
	local CROWN_IMAGE = "rbxassetid://84007601045292"
	local CROWN_GUI_NAME = "TopLevelCrownBillboard"
	local CROWN_REFRESH_INTERVAL = 0.5
	local CROWN_EXTRA_GAP = 2.75
	local CROWN_HP_CLEARANCE_MULTIPLIER = 1.2

	local crownGui = nil :: BillboardGui?

	local function getProgressScore(player: Player): (number, number)
		local userData = if UserDataService ~= nil and typeof((UserDataService :: any).Get) == "function" then (UserDataService :: any).Get(player.UserId) else nil
		local expData = if typeof(userData) == "table" then userData.exp else nil
		local level = math.max(1, math.floor(tonumber(expData and expData.level) or 1))
		local exp = math.max(0, math.floor(tonumber(expData and expData.current) or 0))
		return level, exp
	end

	local function getModelAdornee(model: Model?): BasePart?
		if model == nil then
			return nil
		end

		local root = model:FindFirstChild("Root", true)
		if root ~= nil and root:IsA("BasePart") then
			return root
		end

		local boatMass = model:FindFirstChild("BoatMass", true)
		if boatMass ~= nil and boatMass:IsA("BasePart") then
			return boatMass
		end

		if model.PrimaryPart ~= nil then
			return model.PrimaryPart
		end

		local basePart = model:FindFirstChildWhichIsA("BasePart", true)
		if basePart ~= nil then
			return basePart
		end

		return nil
	end

	local function getBoatModel(player: Player): Model?
		local boatsFolder = Workspace:FindFirstChild("Boats")
		if boatsFolder ~= nil then
			local boatModel = boatsFolder:FindFirstChild(tostring(player.UserId))
			if boatModel ~= nil and boatModel:IsA("Model") then
				return boatModel
			end
		end

		return nil
	end

	local function getModelExtents(model: Model): Vector3
		local ok, extents = pcall(function()
			return model:GetExtentsSize()
		end)
		if not ok or typeof(extents) ~= "Vector3" then
			return Vector3.new(1, 1, 1)
		end

		return Vector3.new(
			math.max(0.01, extents.X),
			math.max(0.01, extents.Y),
			math.max(0.01, extents.Z)
		)
	end

	local function getModelTopY(model: Model): number?
		local topY: number? = nil

		for _, d in ipairs(model:GetDescendants()) do
			if not d:IsA("BasePart") then
				continue
			end

			local extentsCFrame = d.ExtentsCFrame
			local extentsSize = d.ExtentsSize
			local partTopY = extentsCFrame.Position.Y + extentsSize.Y * 0.5
			if topY == nil or partTopY > topY then
				topY = partTopY
			end
		end

		if topY ~= nil then
			return topY
		end

		local ok, cf, size = pcall(function()
			return model:GetBoundingBox()
		end)
		if ok and typeof(cf) == "CFrame" and typeof(size) == "Vector3" then
			return cf.Position.Y + size.Y * 0.5
		end

		return nil
	end

	local function getTopAnchoredYOffset(model: Model, adornee: BasePart?, extents: Vector3, gapFactor: number, minGap: number, maxGap: number): number
		local anchorY = if adornee then adornee.Position.Y else model:GetPivot().Position.Y
		local modelTopY = getModelTopY(model)
		local aboveTopDelta = 0
		if typeof(modelTopY) == "number" then
			aboveTopDelta = math.max(0, modelTopY - anchorY)
		else
			aboveTopDelta = extents.Y * 0.5
		end

		local visualGap = math.clamp(extents.Y * gapFactor + 0.8, minGap, maxGap)
		return aboveTopDelta + visualGap
	end

	local function getBoatHpBillboardProfile(model: Model, adornee: BasePart?): (number, number, number)
		local extents = getModelExtents(model)
		local maxXZ = math.max(extents.X, extents.Z)
		local widthByX = math.clamp(extents.X * 1.25 + 1.0, 6, 32)
		local widthByOther = math.clamp(maxXZ * 0.55 + 1.2, 4, 24)
		local width = math.clamp(widthByX * 0.8 + widthByOther * 0.2, 7, 30)
		local heightScale = math.clamp(width * 0.3, 1.8, 7.8)
		local yOffset = getTopAnchoredYOffset(model, adornee, extents, 0.14, 1.7, 10)
		return width, heightScale, yOffset
	end

	local function getCrownTarget(player: Player): (Model?, BasePart?, number)
		local boatModel = getBoatModel(player)
		if boatModel == nil then
			return nil, nil, 0
		end

		local adornee = getModelAdornee(boatModel)
		if adornee == nil then
			return nil, nil, 0
		end

		local _, hpHeightScale, hpYOffset = getBoatHpBillboardProfile(boatModel, adornee)
		local crownYOffset = hpYOffset + hpHeightScale * CROWN_HP_CLEARANCE_MULTIPLIER + CROWN_EXTRA_GAP
		return boatModel, adornee, crownYOffset
	end

	local function destroyCrown()
		if crownGui ~= nil then
			crownGui:Destroy()
		end
		crownGui = nil
	end

	local function ensureCrownGui(): BillboardGui
		if crownGui ~= nil and crownGui.Parent ~= nil then
			return crownGui
		end

		local gui = Instance.new("BillboardGui")
		gui.Name = CROWN_GUI_NAME
		gui.AlwaysOnTop = false
		gui.LightInfluence = 0
		gui.MaxDistance = 250
		gui.Size = UDim2.fromOffset(64, 64)
		gui.StudsOffsetWorldSpace = Vector3.new(0, 4.5, 0)
		gui.Parent = Workspace

		local image = Instance.new("ImageLabel")
		image.Name = "Icon"
		image.BackgroundTransparency = 1
		image.BorderSizePixel = 0
		image.Size = UDim2.fromScale(1, 1)
		image.Image = CROWN_IMAGE
		image.ScaleType = Enum.ScaleType.Fit
		image.ZIndex = 0
		image.Parent = gui

		crownGui = gui
		return gui
	end

	local function getTopProgressPlayer(): Player?
		local bestPlayer = nil :: Player?
		local bestLevel = -1
		local bestExp = -1
		local bestUserId = math.huge

		for _, player in ipairs(Players:GetPlayers()) do
			local level, exp = getProgressScore(player)
			if bestPlayer == nil
				or level > bestLevel
				or (level == bestLevel and exp > bestExp)
				or (level == bestLevel and exp == bestExp and player.UserId < bestUserId)
			then
				bestPlayer = player
				bestLevel = level
				bestExp = exp
				bestUserId = player.UserId
			end
		end

		return bestPlayer
	end

	local function refreshTopLevelCrown()
		local topPlayer = getTopProgressPlayer()
		if topPlayer == nil then
			destroyCrown()
			return
		end

		local _boatModel, adornee, crownYOffset = getCrownTarget(topPlayer)
		if adornee == nil or adornee.Parent == nil then
			destroyCrown()
			return
		end

		local gui = ensureCrownGui()
		gui.Adornee = adornee
		gui.StudsOffsetWorldSpace = Vector3.new(0, crownYOffset, 0)
		gui.Enabled = true
	end

	local crownRefreshAccum = CROWN_REFRESH_INTERVAL
	RunService.Heartbeat:Connect(function(dt: number)
		crownRefreshAccum += dt
		if crownRefreshAccum < CROWN_REFRESH_INTERVAL then
			return
		end
		crownRefreshAccum = 0
		refreshTopLevelCrown()
	end)

	Players.PlayerAdded:Connect(function(player: Player)
		player.CharacterAdded:Connect(function()
			task.defer(refreshTopLevelCrown)
		end)
		task.defer(refreshTopLevelCrown)
	end)

	Players.PlayerRemoving:Connect(function()
		task.defer(refreshTopLevelCrown)
	end)

	for _, player: Player in ipairs(Players:GetPlayers()) do
		player.CharacterAdded:Connect(function()
			task.defer(refreshTopLevelCrown)
		end)
	end

	task.defer(refreshTopLevelCrown)
end
--//

do
	local IsStudio: boolean = game:GetService("RunService"):IsStudio()
	local delayTime: number = if IsStudio then 0.5 else 2.5
	game:BindToClose(function()
		task.wait(delayTime)
	end)
end
