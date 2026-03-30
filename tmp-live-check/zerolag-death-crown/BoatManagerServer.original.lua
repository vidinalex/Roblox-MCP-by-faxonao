local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local T = require(game.ReplicatedStorage.Utils.Types)
local Aether = require(game.ReplicatedStorage.Aether)
local Enums = require(ReplicatedStorage.Utils.Enums)

--// Services
local BoatService = Aether:LoadLibrary("BoatService")
local SoundService = Aether:LoadLibrary("SoundService")
local EffectsService = Aether:LoadLibrary("EffectsService")
local AbilityService = Aether:LoadLibrary("AbilityService")
local ExperienceService = Aether:LoadLibrary("ExperienceService")
local RelicsService = Aether:LoadLibrary("RelicsService")
local BoatTemplates = Aether:LoadLibrary("BoatTemplates")
local WorldGenerationBootstrap = Aether:LoadLibrary("WorldGenerationBootstrap")
local UserDataService = Aether:LoadLibrary("UserDataService")
local UserDataManagerServer = Aether:LoadLibrary("UserDataManagerServer")
local RespawnService = Aether:LoadLibrary("RespawnService")
local WeaponService = Aether:LoadLibrary("WeaponService")
local WeaponConfig = Aether:LoadLibrary("WeaponConfig")
local ExperienceConfig = Aether:LoadLibrary("ExperienceConfig")
local BoatProgressionFunnelServer = require(game.ServerScriptService.Mechanics.Analytics.Server.BoatProgressionFunnelServer)
--//

--// Classes
local BOAT_SERVER_CLASS = require(game.ServerScriptService.Utils.Classes.Boats.BoatServer)
--//

local BoatManagerServer = {}

local RESPAWN_DELAY_SECONDS = 6
local SWITCH_TRANSITION_SUPPRESSION_SECONDS = 0.5
local SAVE_SHIP_RESTORE_SUPPRESSION_SECONDS = 1.5
local VOID_RESPAWN_MARGIN = 32
local USER_DATA_TEMPLATE = require(game.ServerScriptService.Mechanics.UserData.Server.UserDataManagerServer.Template)
local DEFAULT_RESPAWN_BOAT_ID = if typeof(USER_DATA_TEMPLATE.boat) == "table"
	and typeof(USER_DATA_TEMPLATE.boat.templateId) == "string"
	and USER_DATA_TEMPLATE.boat.templateId ~= ""
	then USER_DATA_TEMPLATE.boat.templateId
	else "Raft"

local respawnTokenByUserId: { [number]: number } = {}
local respawnPendingTokenByUserId: { [number]: number } = {}
local respawnSessionByUserId: { [number]: { [string]: any } } = {}
local deathConnByUserId: { [number]: any } = {}
local characterConnsByUserId: { [number]: { [string]: any } } = {}
local playerLifecycleConnsByUserId: { [number]: { [string]: any } } = {}
local respawnSuppressionCountByUserId: { [number]: number } = {}
local boatTransitionCountByUserId: { [number]: number } = {}

local disconnectDeathConn: any
local nextToken: any
local spawnBoat: any
local hookDeath: any
local resolveRespawnTemplate: any
local getServerNow: any
local getRespawnSession: any
local getSnapshotBoatTemplateId: any
local buildRespawnState: any
local fireRespawnStateChanged: any
local captureRespawnSnapshot: any
local restoreRespawnSession: any
local applyDeathRespawnReset: any
local scheduleFullRespawn: any
local ensureBoatForPlayer: any
local ensurePlayerLifecycleConnections: any

local function disconnectConnection(connection :any)
	if connection ~= nil and type(connection.Disconnect) == "function" then
		connection:Disconnect()
	end
end

local function disconnectConnections(connections :{ [string]: any }?)
	if connections == nil then
		return
	end

	for key :string, connection :any in pairs(connections) do
		disconnectConnection(connection)
		connections[key] = nil
	end
end

local function disconnectCharacterConns(userId: number)
	local connections = characterConnsByUserId[userId]
	characterConnsByUserId[userId] = nil
	disconnectConnections(connections)
end

local function disconnectPlayerLifecycleConns(userId: number)
	local connections = playerLifecycleConnsByUserId[userId]
	playerLifecycleConnsByUserId[userId] = nil
	disconnectConnections(connections)
end

local function beginRespawnSuppression(userId: number)
	respawnSuppressionCountByUserId[userId] = (respawnSuppressionCountByUserId[userId] or 0) + 1
end

local function endRespawnSuppression(userId: number)
	local nextValue = (respawnSuppressionCountByUserId[userId] or 0) - 1
	if nextValue > 0 then
		respawnSuppressionCountByUserId[userId] = nextValue
	else
		respawnSuppressionCountByUserId[userId] = nil
	end
end

local function isRespawnSuppressed(userId: number): boolean
	return (respawnSuppressionCountByUserId[userId] or 0) > 0
end

local function beginBoatTransition(userId: number)
	boatTransitionCountByUserId[userId] = (boatTransitionCountByUserId[userId] or 0) + 1
	beginRespawnSuppression(userId)
end

local function endBoatTransition(userId: number)
	local nextValue = (boatTransitionCountByUserId[userId] or 0) - 1
	if nextValue > 0 then
		boatTransitionCountByUserId[userId] = nextValue
	else
		boatTransitionCountByUserId[userId] = nil
	end
	endRespawnSuppression(userId)
end

local function isBoatTransitionActive(userId: number): boolean
	return (boatTransitionCountByUserId[userId] or 0) > 0
end

local function cancelPendingRespawn(userId: number, token: number?)
	if token ~= nil and respawnPendingTokenByUserId[userId] ~= token then
		return
	end
	respawnPendingTokenByUserId[userId] = nil
end

local function getBoatOwnerUserId(boat: any): number?
	if boat == nil then
		return nil
	end

	if typeof(boat.GetOwnerUserId) == "function" then
		local ok, ownerUserId = pcall(function()
			return boat:GetOwnerUserId()
		end)
		if ok and typeof(ownerUserId) == "number" then
			return ownerUserId
		end
	end

	local owner = boat.GetOwner and boat:GetOwner()
	local ownerUserId = owner and owner.UserId
	if typeof(ownerUserId) == "number" then
		return ownerUserId
	end

	return nil
end

local function getBoatFallbackTemplate(boat: any): any
	if boat ~= nil and typeof(boat.GetTemplate) == "function" then
		local ok, template = pcall(function()
			return boat:GetTemplate()
		end)
		if ok then
			return template
		end
	end

	return nil
end

local function getPlayerByUserId(userId: number): Player?
	local ok, player = pcall(function()
		return Players:GetPlayerByUserId(userId)
	end)
	if ok and player ~= nil then
		return player
	end

	return nil
end

local function getVoidThresholdY(): number
	local destroyY = Workspace.FallenPartsDestroyHeight
	if typeof(destroyY) ~= "number" then
		return -500
	end

	return destroyY - VOID_RESPAWN_MARGIN
end

local function isBoatInvalid(boat: any): boolean
	if boat == nil then
		return true
	end
	if (boat :: any).isDestroyed == true then
		return true
	end

	local model = boat.GetModel and boat:GetModel()
	if typeof(model) ~= "Instance" or not model:IsA("Model") then
		return true
	end
	if model.Parent == nil or not model:IsDescendantOf(Workspace) then
		return true
	end
	if model.PrimaryPart == nil or model.PrimaryPart.Parent == nil then
		return true
	end
	if model.PrimaryPart.Position.Y <= getVoidThresholdY() then
		return true
	end

	return false
end

local function bindCharacterSignals(player: Player, character: Model)
	local userId = player.UserId
	disconnectCharacterConns(userId)

	local connections :{ [string]: any } = {}
	characterConnsByUserId[userId] = connections

	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if humanoid ~= nil then
		connections.HumanoidDied = humanoid.Died:Connect(function()
			scheduleFullRespawn(player, "humanoid_died", nil)
		end)
	end

	connections.AncestryChanged = character.AncestryChanged:Connect(function(_child, parent)
		if parent == nil then
			scheduleFullRespawn(player, "character_removed", nil)
		end
	end)
end

function BoatManagerServer.GetBoat(userId :number) :BOAT_SERVER_CLASS.BoatServer?
	return BoatService.GetBoat(userId)
end

function BoatManagerServer.WaitForLoad(userId :number) :BOAT_SERVER_CLASS.BoatServer?
	return BoatService.WaitForLoad(userId)
end

function BoatManagerServer.GetBoats() :{ [number] :BOAT_SERVER_CLASS.BoatServer }
	return BoatService.GetBoats()
end


function BoatManagerServer.GetRespawnState(player: Player): { [string]: any }
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		return buildRespawnState(0)
	end
	return buildRespawnState(player.UserId)
end

function BoatManagerServer.PrepareSaveShipPurchase(player: Player, token: number): (boolean, string, { [string]: any })
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		return false, "InvalidPlayer", buildRespawnState(0)
	end

	local userId = player.UserId
	local session = getRespawnSession(userId)
	if session == nil then
		return false, "NoActiveRespawn", buildRespawnState(userId)
	end

	local expectedToken = math.max(0, math.floor(tonumber(session.token) or 0))
	local desiredToken = math.max(0, math.floor(tonumber(token) or 0))
	if desiredToken ~= expectedToken then
		return false, "TokenMismatch", buildRespawnState(userId)
	end

	local status = tostring(session.status or "idle")
	if session.paidRestoreConsumed == true or (status ~= "waiting_auto" and status ~= "auto_respawned") then
		return false, "SaveShipUnavailable", buildRespawnState(userId)
	end

	session.preparedSaveShipToken = expectedToken
	fireRespawnStateChanged(userId)
	return true, "Prepared", buildRespawnState(userId)
end

function BoatManagerServer.TryConsumeSaveShipReceipt(player: Player): boolean
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		return false
	end

	local userId = player.UserId
	local session = getRespawnSession(userId)
	if session == nil then
		warn("[BoatManagerServer] Consuming stale SaveShip receipt without active respawn session", userId)
		return true
	end

	local token = math.max(0, math.floor(tonumber(session.token) or 0))
	local preparedToken = math.max(0, math.floor(tonumber(session.preparedSaveShipToken) or 0))
	if session.paidRestoreConsumed == true or preparedToken ~= token then
		warn("[BoatManagerServer] Consuming stale SaveShip receipt for token mismatch", userId, preparedToken, token)
		return true
	end

	local status = tostring(session.status or "idle")
	if status ~= "waiting_auto" and status ~= "auto_respawned" then
		warn("[BoatManagerServer] Consuming stale SaveShip receipt for inactive session", userId, status)
		return true
	end

	local ok, err = restoreRespawnSession(player, session)
	if ok ~= true then
		warn("[BoatManagerServer] SaveShip restore failed:", err)
		return false
	end

	session.status = "paid_restored"
	session.paidRestoreConsumed = true
	session.preparedSaveShipToken = nil
	fireRespawnStateChanged(userId)
	return true
end

function BoatManagerServer.SwitchBoat(player: Player, templateId: string, useWorldGen: boolean?): (boolean, string?)
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		return false, "Invalid player"
	end
	if typeof(templateId) ~= "string" or templateId == "" then
		return false, "Invalid templateId"
	end

	local template = BoatTemplates.GetTemplate(templateId)
	if not template then
		return false, `Unknown templateId "{templateId}"`
	end

	local userId = player.UserId
	cancelPendingRespawn(userId)
	nextToken(userId)
	disconnectDeathConn(userId)

	local transitionSuppressed = false
	local existing = BoatService.GetBoat(userId)
	local spawnCFrame: CFrame? = nil

	local oldSpeed :Vector3 = Vector3.zero
	local rotateSpeed :Vector3 = Vector3.zero
	if existing and existing:GetModel() then
		local massPart :BasePart = existing:GetModel().Boat:FindFirstChild("BoatMass")
		oldSpeed = massPart and massPart.AssemblyLinearVelocity or oldSpeed
		rotateSpeed = massPart and massPart.AssemblyAngularVelocity or rotateSpeed
	end

	if existing then
		local m = (existing :: any).GetModel and (existing :: any):GetModel()
		if m and typeof(m) == "Instance" and m:IsA("Model") then
			spawnCFrame = m:GetPivot()
		end

		local boatPosition :Vector3 = Vector3.zero
		local size :number = 5
		if existing:GetModel() then
			local _, boatSize :Vector3 = existing:GetModel():GetBoundingBox()
			size = boatSize.Magnitude

			local boatMass :BasePart? = existing:GetModel().Boat:FindFirstChild("BoatMass")
			if boatMass then
				boatPosition = boatMass.Position
			end
		end

		beginBoatTransition(userId)
		transitionSuppressed = true
		pcall(function()
			(existing :: any):Destroy()
		end)

		EffectsService.EmitEffect(EffectsService.effects.BoatUpgrade, CFrame.new(boatPosition), {size = size * 0.8})
		SoundService.PlaySoundAt(game.ReplicatedStorage.Sounds.Other.ShipUpgrade, boatPosition)
	end

	local newBoat = spawnBoat(player, template, useWorldGen == true, spawnCFrame)
	hookDeath(player, newBoat)

	newBoat:GetModel().Boat.BoatMass.AssemblyLinearVelocity = oldSpeed
	newBoat:GetModel().Boat.BoatMass.AssemblyAngularVelocity = rotateSpeed

	if transitionSuppressed then
		task.delay(SWITCH_TRANSITION_SUPPRESSION_SECONDS, function()
			endBoatTransition(userId)
			if player.Parent and BoatService.GetBoat(userId) == nil then
				ensureBoatForPlayer(player)
			end
		end)
	end

	return true
end

disconnectDeathConn = function(userId: number)
	local conn = deathConnByUserId[userId]
	deathConnByUserId[userId] = nil
	disconnectConnection(conn)
end

nextToken = function(userId: number): number
	local t = (respawnTokenByUserId[userId] or 0) + 1
	respawnTokenByUserId[userId] = t
	return t
end

local function applyInvulnerability(player :Player)
	local abilityStorage = AbilityService.WaitAbilityStorage(player.UserId)
	if not abilityStorage then return end

	abilityStorage.values.invulnerability:Set(1, "SpawnShield")
	task.delay(10, function()
		if abilityStorage.isDestroyed then return end
		abilityStorage.values.invulnerability:Set(0, "SpawnShield")
	end)
end

local function getSafeRespawnCFrame(useWorldGen: boolean): CFrame
	if not useWorldGen then
		return CFrame.new(Vector3.new(0, 10, 0))
	end

	if WorldGenerationBootstrap and typeof(WorldGenerationBootstrap) == "table" and typeof(WorldGenerationBootstrap.EnsureRun) == "function" then
		local ok, run = pcall(function()
			return (WorldGenerationBootstrap :: any).EnsureRun()
		end)
		if ok and run and typeof(run) == "table" and typeof((run :: any).GetRandomBoatPosition) == "function" then
			local ok2, cf = pcall(function()
				local c = (run :: any):GetRandomBoatPosition()
				if typeof(c) == "CFrame" then
					return c
				end
				return nil
			end)
			if ok2 and typeof(cf) == "CFrame" then
				return cf
			end
		end
	end

	return CFrame.new(Vector3.new(0, 10, 0))
end

spawnBoat = function(player: Player, template: any?,
	useWorldGen: boolean, overrideCFrame: CFrame?): BOAT_SERVER_CLASS.BoatServer
	
	local boatTemplate = template or BoatTemplates.list.Raft
	local cf = if typeof(overrideCFrame) == "CFrame" then overrideCFrame else getSafeRespawnCFrame(useWorldGen == true)
	
	--// Create Boat
	local boatServer :BOAT_SERVER_CLASS.BoatServer = BOAT_SERVER_CLASS.New({
		owner = player,
		template = boatTemplate,
		cframe = cf,
	})
	
	boatServer:GetModel().PrimaryPart.AncestryChanged:Connect(function()
		if boatServer.isDestroyed
			or boatServer:GetModel().PrimaryPart and boatServer:GetModel().PrimaryPart.Parent
		then
			return
		end

		boatServer:Destroy()
	end)
	--//
	
	local replicationFocus = boatServer:GetModel().PrimaryPart
	if player.Parent and Workspace.StreamingEnabled == true and replicationFocus ~= nil then
		player:AddReplicationFocus(replicationFocus)
	end

	return boatServer
end

resolveRespawnTemplate = function(player: Player, fallbackTemplate: any?): any
	local userData = UserDataService.Get(player.UserId)
	local boatTemplate :any = BoatTemplates.list.Raft
	
	pcall(function()
		(ExperienceService :: any).Reconcile(player)
	end)
	
	if userData.relics.equipped then
		local relic = RelicsService.templates.GetTemplateById(userData.relics.equipped)
		if relic then
			local template = BoatTemplates.GetExperienceSortedList()[relic:GetStartLevel()]
			if template then
				return template
			end
		end
	end

	local defaultTemplate = BoatTemplates.GetTemplate(DEFAULT_RESPAWN_BOAT_ID)
	if defaultTemplate then
		return defaultTemplate
	end

	return fallbackTemplate
end


getServerNow = function(): number
	return Workspace:GetServerTimeNow()
end

getRespawnSession = function(userId: number): { [string]: any }?
	local session = respawnSessionByUserId[userId]
	if typeof(session) == "table" then
		return session
	end
	return nil
end

getSnapshotBoatTemplateId = function(player: Player, currentBoat: any?): string
	if currentBoat ~= nil and typeof(currentBoat.GetTemplate) == "function" then
		local okTemplate, template = pcall(function()
			return currentBoat:GetTemplate()
		end)
		if okTemplate and template ~= nil and typeof((template :: any).GetId) == "function" then
			local okId, templateId = pcall(function()
				return (template :: any):GetId()
			end)
			if okId and typeof(templateId) == "string" and templateId ~= "" then
				return templateId
			end
		end
	end

	local userData = UserDataService.Get(player.UserId)
	if typeof(userData) == "table" and typeof(userData.boat) == "table" then
		local templateId = userData.boat.templateId
		if typeof(templateId) == "string" and templateId ~= "" then
			return templateId
		end
	end

	return DEFAULT_RESPAWN_BOAT_ID
end

captureRespawnSnapshot = function(player: Player, currentBoat: any?): { [string]: any }
	local userData = UserDataService.Get(player.UserId)
	local expCurrent = 0
	local expLevel = ExperienceConfig.GetLevelForExp(0)
	if typeof(userData) == "table" and typeof(userData.exp) == "table" then
		expCurrent = math.max(0, math.floor(tonumber(userData.exp.current) or 0))
		expLevel = math.max(1, math.floor(tonumber(userData.exp.level) or ExperienceConfig.GetLevelForExp(expCurrent)))
	end

	local weaponId = WeaponConfig.DefaultBoatWeaponId
	if WeaponService ~= nil and typeof((WeaponService :: any).GetWeaponIdForUserId) == "function" then
		local okWeapon, resolvedWeaponId = pcall(function()
			return (WeaponService :: any).GetWeaponIdForUserId(player.UserId)
		end)
		if okWeapon and typeof(resolvedWeaponId) == "string" and resolvedWeaponId ~= "" then
			weaponId = resolvedWeaponId
		end
	end

	return {
		expCurrent = expCurrent,
		expLevel = expLevel,
		boatTemplateId = getSnapshotBoatTemplateId(player, currentBoat),
		weaponId = weaponId,
	}
end

buildRespawnState = function(userId: number): { [string]: any }
	local session = getRespawnSession(userId)
	if session == nil then
		return {
			token = 0,
			status = "idle",
			autoRespawnAt = 0,
			canSaveShip = false,
			isPreparedForPurchase = false,
		}
	end

	local token = math.max(0, math.floor(tonumber(session.token) or 0))
	local preparedToken = math.max(0, math.floor(tonumber(session.preparedSaveShipToken) or 0))
	local status = tostring(session.status or "idle")
	local canSaveShip = session.paidRestoreConsumed ~= true and (status == "waiting_auto" or status == "auto_respawned")

	return {
		token = token,
		status = status,
		autoRespawnAt = math.max(0, tonumber(session.autoRespawnAt) or 0),
		canSaveShip = canSaveShip,
		isPreparedForPurchase = canSaveShip and preparedToken == token,
	}
end

fireRespawnStateChanged = function(userId: number)
	local player = getPlayerByUserId(userId)
	if player == nil then
		return
	end
	if RespawnService == nil or typeof((RespawnService :: any)._NET) ~= "table" or (RespawnService :: any)._NET.STATE_CHANGED == nil then
		return
	end
	pcall(function()
		(RespawnService :: any)._NET.STATE_CHANGED:FireClient(player, buildRespawnState(userId))
	end)
end

restoreRespawnSession = function(player: Player, session: { [string]: any }): (boolean, string?)
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		return false, "InvalidPlayer"
	end
	if typeof(session) ~= "table" or typeof(session.snapshot) ~= "table" then
		return false, "MissingSnapshot"
	end

	local userId = player.UserId
	local snapshot = session.snapshot
	local expCurrent = math.max(0, math.floor(tonumber(snapshot.expCurrent) or 0))
	local expLevel = math.max(1, math.floor(tonumber(snapshot.expLevel) or ExperienceConfig.GetLevelForExp(expCurrent)))
	local boatTemplateId = if typeof(snapshot.boatTemplateId) == "string" and snapshot.boatTemplateId ~= "" then snapshot.boatTemplateId else DEFAULT_RESPAWN_BOAT_ID
	local weaponId = if typeof(snapshot.weaponId) == "string" and snapshot.weaponId ~= "" then snapshot.weaponId else WeaponConfig.DefaultBoatWeaponId

	local userData = UserDataService.Get(userId)
	if userData == nil then
		userData = UserDataService.WaitForLoad(userId)
	end
	if userData == nil then
		return false, "DataNotLoaded"
	end

	local okSetExp, setExpErr = ExperienceService.SetExp(player, expCurrent, "save_ship_restore")
	if okSetExp ~= true then
		return false, tostring(setExpErr or "SetExpFailed")
	end

	userData = UserDataService.Get(userId) or userData
	if typeof(userData.exp) ~= "table" then
		userData.exp = { current = expCurrent, level = expLevel }
	end
	userData.exp.current = expCurrent
	userData.exp.level = expLevel

	if typeof(userData.boat) ~= "table" then
		userData.boat = { templateId = boatTemplateId }
	end
	userData.boat.templateId = boatTemplateId
	UserDataManagerServer.PushReason(userId, Enums.DataChangeReason.EXP_CHANGED)
	WeaponService.SetDesiredWeaponId(userId, weaponId)

	local template = BoatTemplates.GetTemplate(boatTemplateId)
	if template == nil then
		template = resolveRespawnTemplate(player, nil)
	end
	if template == nil then
		return false, "TemplateMissing"
	end

	disconnectDeathConn(userId)
	cancelPendingRespawn(userId, tonumber(session.token))

	beginRespawnSuppression(userId)
	local okSpawn, spawnErr = pcall(function()
		local currentBoat = BoatService.GetBoat(userId)
		if currentBoat ~= nil and (currentBoat :: any).isDestroyed ~= true then
			pcall(function()
				(currentBoat :: any):Destroy()
			end)
		end

		local restoredBoat = spawnBoat(player, template, true, nil)
		applyInvulnerability(player)
		hookDeath(player, restoredBoat)
	end)

	if not okSpawn then
		endRespawnSuppression(userId)
		return false, tostring(spawnErr)
	end

	task.delay(SAVE_SHIP_RESTORE_SUPPRESSION_SECONDS, function()
		endRespawnSuppression(userId)
	end)

	return true, nil
end

applyDeathRespawnReset = function(player: Player)
	local userData = UserDataService.Get(player.UserId)
	if typeof(userData) ~= "table" then
		return
	end

	local expData = userData.exp
	if typeof(expData) == "table" then
		expData.current = 0
		expData.level = ExperienceConfig.GetLevelForExp(0)
	end

	local boatData = userData.boat
	if typeof(boatData) == "table" then
		boatData.templateId = DEFAULT_RESPAWN_BOAT_ID
	end

	UserDataManagerServer.PushReason(player.UserId, Enums.DataChangeReason.EXP_CHANGED)
	WeaponService.SetDesiredWeaponId(player.UserId, WeaponConfig.DefaultBoatWeaponId)
	BoatProgressionFunnelServer.StartSession(player, "death_reset")
end


scheduleFullRespawn = function(player: Player, _reason: string, fallbackTemplate: any?)
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		return
	end
	if not player.Parent then
		return
	end

	local userId = player.UserId
	if isRespawnSuppressed(userId) or isBoatTransitionActive(userId) then
		return
	end
	if respawnPendingTokenByUserId[userId] ~= nil then
		return
	end

	local currentBoat = BoatService.GetBoat(userId)
	local token = nextToken(userId)
	respawnPendingTokenByUserId[userId] = token
	fallbackTemplate = fallbackTemplate or getBoatFallbackTemplate(currentBoat)

	respawnSessionByUserId[userId] = {
		token = token,
		status = "waiting_auto",
		startedAt = getServerNow(),
		autoRespawnAt = getServerNow() + RESPAWN_DELAY_SECONDS,
		snapshot = captureRespawnSnapshot(player, currentBoat),
		preparedSaveShipToken = nil,
		paidRestoreConsumed = false,
	}
	fireRespawnStateChanged(userId)

	disconnectDeathConn(userId)
	disconnectCharacterConns(userId)
	applyDeathRespawnReset(player)

	beginRespawnSuppression(userId)
	if currentBoat ~= nil and (currentBoat :: any).isDestroyed ~= true then
		pcall(function()
			(currentBoat :: any):Destroy()
		end)
	end
	endRespawnSuppression(userId)

	task.delay(RESPAWN_DELAY_SECONDS, function()
		if respawnPendingTokenByUserId[userId] ~= token then
			return
		end
		if not player.Parent then
			cancelPendingRespawn(userId, token)
			return
		end
		if respawnTokenByUserId[userId] ~= token then
			cancelPendingRespawn(userId, token)
			return
		end
		if BoatService.GetBoat(userId) ~= nil then
			cancelPendingRespawn(userId, token)
			return
		end

		local template = resolveRespawnTemplate(player, fallbackTemplate)
		applyInvulnerability(player)

		local newBoat = spawnBoat(player, template, true, nil)
		hookDeath(player, newBoat)
		cancelPendingRespawn(userId, token)

		local session = getRespawnSession(userId)
		if session ~= nil and tonumber(session.token) == token and session.paidRestoreConsumed ~= true then
			session.status = "auto_respawned"
			fireRespawnStateChanged(userId)
		end
	end)
end


hookDeath = function(player: Player, boat: BOAT_SERVER_CLASS.BoatServer)
	if boat == nil or (boat :: any).isDestroyed == true then
		return
	end

	local userId = player.UserId
	disconnectDeathConn(userId)

	deathConnByUserId[userId] = boat.health.onValueChanged:Connect(function(numberController, payload)
		if boat.health ~= numberController then
			return
		end
		if typeof(payload) ~= "table" then
			return
		end

		local current = payload.current
		local previous = payload.previous
		if current ~= 0 or previous == 0 then
			return
		end
		
		--// Emit Effects
		local modelCFrame :CFrame, modelSize :Vector3 = boat:GetModel():GetPivot()
		EffectsService.EmitEffect(game.ReplicatedStorage.Prefabs.VFX.BoatDeath, modelCFrame, {
			partSize = modelSize,
			size = 25 + 15 * boat:GetTemplate():GetModelScale(),
		})
		SoundService.PlaySoundAt(game.ReplicatedStorage.Sounds.Boat.Destruction, modelCFrame.Position)
		--//
		
		scheduleFullRespawn(player, "boat_health_zero", getBoatFallbackTemplate(boat))
	end)
end

ensurePlayerLifecycleConnections = function(player: Player)
	local userId = player.UserId
	if playerLifecycleConnsByUserId[userId] ~= nil then
		if player.Character ~= nil then
			bindCharacterSignals(player, player.Character)
		end
		return
	end

	playerLifecycleConnsByUserId[userId] = {
		CharacterAdded = player.CharacterAdded:Connect(function(character: Model)
			bindCharacterSignals(player, character)
		end),
		CharacterRemoving = player.CharacterRemoving:Connect(function(_character: Model)
			scheduleFullRespawn(player, "character_removing", nil)
		end),
	}

	if player.Character ~= nil then
		bindCharacterSignals(player, player.Character)
	end
end

ensureBoatForPlayer = function(player: Player)
	--// Wait When User Data Load
	local userData :T.UserData = UserDataService.WaitForLoad(player.UserId)
	if not userData then
		return
	end
	--//
	
	local userId = player.UserId
	local existing = BoatService.GetBoat(userId)
	if isBoatInvalid(existing) then
		if existing ~= nil and (existing :: any).isDestroyed ~= true then
			beginRespawnSuppression(userId)
			pcall(function()
				(existing :: any):Destroy()
			end)
			endRespawnSuppression(userId)
		end
		existing = nil
	end
	
	if existing then
		hookDeath(player, existing :: any)
		return existing
	end
	
	if ExperienceService ~= nil and typeof((ExperienceService :: any).Reconcile) == "function" then
		pcall(function()
			(ExperienceService :: any).Reconcile(player)
		end)
		userData = UserDataService.WaitForLoad(player.UserId) or userData
	end
	
	local boatTemplate :any = BoatTemplates.list.Raft
	if userData.relics.equipped then
		local relic = RelicsService.templates.GetTemplateById(userData.relics.equipped)
		if relic then
			boatTemplate = BoatTemplates.GetExperienceSortedList()[relic:GetStartLevel()] or boatTemplate
		end
	end
	
	--if typeof(userData.boat) == "table" and typeof(userData.boat.templateId) == "string" and userData.boat.templateId ~= "" then
	--	local resolvedBoatTemplate = BoatTemplates.GetTemplate(userData.boat.templateId)
	--	if resolvedBoatTemplate then
	--		boatTemplate = resolvedBoatTemplate
	--	end
	--end
	
	local boat = spawnBoat(player, boatTemplate, false, nil)
	applyInvulnerability(player)
	hookDeath(player, boat)
	return boat
end

BoatManagerServer.getSafeRespawnCFrame = getSafeRespawnCFrame

if typeof(BoatService) == "table" and typeof((BoatService :: any).onBoatDestroyed) == "table" then
	(BoatService :: any).onBoatDestroyed:Connect(function(info :{boat :BOAT_SERVER_CLASS.BoatServer})
		if typeof(info) ~= "table" then
			return
		end

		local boat = info.boat
		local ownerUserId = getBoatOwnerUserId(boat)
		if typeof(ownerUserId) ~= "number" then
			return
		end
		if isRespawnSuppressed(ownerUserId) or isBoatTransitionActive(ownerUserId) then
			return
		end
		if respawnPendingTokenByUserId[ownerUserId] ~= nil then
			return
		end

		local player = getPlayerByUserId(ownerUserId)
		if player == nil then
			return
		end

		scheduleFullRespawn(player, "boat_destroyed", getBoatFallbackTemplate(boat))
	end)
end

--// Connections
do
	local CACHE :{ [number] :"Added"|"Removing" } = {}

	local function PlayerAdded(player :Player)
		if CACHE[player.UserId] then
			if CACHE[player.UserId] == "Added" then
				return
			end

			while CACHE[player.UserId] do
				task.wait()
			end
		end

		CACHE[player.UserId] = "Added"
		local ok, err = pcall(function()
			ensurePlayerLifecycleConnections(player)
			ensureBoatForPlayer(player)
		end)
		CACHE[player.UserId] = nil

		if not ok then
			warn("[BoatManagerServer] PlayerAdded failed:", err)
		end
	end

	local function PlayerRemoving(player :Player)
		if CACHE[player.UserId] then
			if CACHE[player.UserId] == "Removing" then
				return
			end

			while CACHE[player.UserId] do
				task.wait()
			end
		end

		CACHE[player.UserId] = "Removing"
		local ok, err = pcall(function()
			cancelPendingRespawn(player.UserId)
			respawnSessionByUserId[player.UserId] = nil
			nextToken(player.UserId)
			disconnectDeathConn(player.UserId)
			disconnectCharacterConns(player.UserId)
			disconnectPlayerLifecycleConns(player.UserId)

			local boat :BOAT_SERVER_CLASS.BoatServer = BoatManagerServer.GetBoat(player.UserId)
			if boat then
				beginRespawnSuppression(player.UserId)
				pcall(function()
					boat:Destroy()
				end)
				endRespawnSuppression(player.UserId)
			end
		end)
		CACHE[player.UserId] = nil

		if not ok then
			warn("[BoatManagerServer] PlayerRemoving failed:", err)
		end
	end

	Players.PlayerAdded:Connect(PlayerAdded)
	Players.PlayerRemoving:Connect(PlayerRemoving)

	for _, plr :Player in ipairs(Players:GetPlayers()) do
		PlayerAdded(plr)
	end
end
--//

--// Update Regenerate / Watchdog
local function Update(dt :number)
	BoatService.ForEachBoat(function(_userId :number, boat :BOAT_SERVER_CLASS.BoatServer)
		if not boat then
			return
		end

		local ownerUserId = getBoatOwnerUserId(boat)
		if typeof(ownerUserId) ~= "number" then
			return
		end

		if isBoatInvalid(boat) then
			local player = getPlayerByUserId(ownerUserId)
			if player ~= nil then
				scheduleFullRespawn(player, "boat_watchdog_invalid", getBoatFallbackTemplate(boat))
			end
			return
		end

		if (boat :: any).isDestroyed == true then
			return
		end
		if not boat.health or not boat._timeToRegenerate then
			return
		end

		local abilityStorage = AbilityService.GetAbilityStorage(ownerUserId)
		if not abilityStorage then
			return
		end

		if boat.health:Get() == boat:GetMaxHealth() then
			boat._timeToRegenerate:Set(0)
			return
		end

		boat._timeToRegenerate:Add(dt)
		if boat._timeToRegenerate:Get() < abilityStorage.values.regenerateDuration:Get() then
			return
		end

		boat._timeToRegenerate:Set(0)

		local value :number = math.round(boat:GetMaxHealth() * abilityStorage.values.regeneratePercent:Get()/100)
		value = math.clamp(value, 1, math.huge)

		if (boat :: any).isDestroyed == true then
			return
		end
		boat.health:Add(value)
	end)
end

RunService.Heartbeat:Connect(Update)
--//

--// Remote Channel
do
	BOAT_SERVER_CLASS.onRemoteToClient:Connect(function(boat :BOAT_SERVER_CLASS.BoatServer, info :{method :string, properties :any})
		local owner = boat:GetOwner()
		if typeof(owner) ~= "Instance" or not owner:IsA("Player") then
			return
		end

		BoatService._NET.RemoteChannel:FireClient(owner, info)
	end)
end
--//




if RespawnService ~= nil and typeof((RespawnService :: any)._NET) == "table" then
	(RespawnService :: any)._NET.GET_STATE.OnServerInvoke = function(player: Player)
		return BoatManagerServer.GetRespawnState(player)
	end

	(RespawnService :: any)._NET.PREPARE_SAVE_SHIP_PURCHASE.OnServerInvoke = function(player: Player, payload: { token: number }?)
		if typeof(payload) ~= "table" then
			return {
				ok = false,
				reason = "InvalidPayload",
				state = BoatManagerServer.GetRespawnState(player),
			}
		end

		local ok, reason, state = BoatManagerServer.PrepareSaveShipPurchase(player, tonumber((payload :: any).token) or 0)
		return {
			ok = ok,
			reason = reason,
			state = state,
		}
	end
end

table.freeze(BoatManagerServer)
return BoatManagerServer