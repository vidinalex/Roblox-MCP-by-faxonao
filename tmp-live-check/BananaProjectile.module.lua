local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local ServerStorage = game:GetService("ServerStorage")

local Maid = require(ReplicatedStorage.Modules.Classes.Maid)
local BananaTrap = require(ServerStorage.ServerClasses.BananaTrap)

local module = {}
module.__index = module

local function getParentContainer(): Instance
	return workspace:FindFirstChild("Debris") or workspace
end

local function getTemplate(): Instance?
	return ReplicatedStorage:FindFirstChild("Abilitys") and ReplicatedStorage.Abilitys:FindFirstChild("BananaPeel")
end

local function getRoot(instance: Instance?): BasePart?
	if not instance then
		return nil
	end

	if instance:IsA("BasePart") then
		return instance
	end

	if instance:IsA("Model") then
		if instance.PrimaryPart then
			return instance.PrimaryPart
		end
		return instance:FindFirstChildWhichIsA("BasePart", true)
	end

	return instance:FindFirstChildWhichIsA("BasePart", true)
end

local function getParts(instance: Instance): {BasePart}
	local parts = {}
	if instance:IsA("BasePart") then
		table.insert(parts, instance)
		return parts
	end

	for _, descendant in ipairs(instance:GetDescendants()) do
		if descendant:IsA("BasePart") then
			table.insert(parts, descendant)
		end
	end

	return parts
end

local function pivot(instance: Instance, cf: CFrame)
	if instance:IsA("Model") then
		instance:PivotTo(cf)
	elseif instance:IsA("BasePart") then
		instance.CFrame = cf
	end
end

local function setVisualState(instance: Instance)
	for _, part in ipairs(getParts(instance)) do
		part.Anchored = true
		part.CanCollide = false
		part.CanTouch = false
		part.CanQuery = false
		part.CastShadow = false
	end
end

local function getHumanoidModel(inst: Instance?): Model?
	if not inst then
		return nil
	end

	local model = inst:FindFirstAncestorOfClass("Model")
	if model and model:FindFirstChildOfClass("Humanoid") then
		return model
	end

	return nil
end

local function isValidTarget(ownerChar: Model?, ownerPlayer: Player?, targetChar: Model?): boolean
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

local function applySlip(targetChar: Model, peelPosition: Vector3, ragdollDuration: number, knockbackStrength: number): boolean
	local humanoid = targetChar:FindFirstChildOfClass("Humanoid")
	local root = targetChar:FindFirstChild("HumanoidRootPart")
	local ragdollValue = targetChar:FindFirstChild("IsRagdoll")
	if not (humanoid and root and ragdollValue and ragdollValue:IsA("BoolValue")) then
		return false
	end

	local dir = root.Position - peelPosition
	dir = Vector3.new(dir.X, 0, dir.Z)
	if dir.Magnitude < 0.1 then
		local look = root.CFrame.LookVector
		dir = Vector3.new(look.X, 0, look.Z)
	end

	if dir.Magnitude < 0.1 then
		dir = Vector3.new(0, 0, -1)
	else
		dir = dir.Unit
	end

	targetChar:SetAttribute("KnockbackDir", dir)
	targetChar:SetAttribute("KnockbackStrength", knockbackStrength)
	ragdollValue.Value = true

	task.delay(ragdollDuration, function()
		if humanoid.Parent and humanoid.Health > 0 and ragdollValue.Parent then
			ragdollValue.Value = false
		end
	end)

	return true
end

function module.new(config)
	local self = setmetatable({}, module)

	self.Maid = Maid.new()
	self.OwnerChar = config.ownerChar
	self.OwnerPlayer = config.ownerPlayer
	self.Position = config.origin
	self.Direction = config.direction.Unit
	self.Velocity = self.Direction * (tonumber(config.speed) or 50) + Vector3.new(0, tonumber(config.upwardVelocity) or 20, 0)
	self.Radius = tonumber(config.projectileRadius) or 1.1
	self.Gravity = Vector3.new(0, -(tonumber(config.gravity) or workspace.Gravity), 0)
	self.MaxFlightTime = tonumber(config.maxFlightTime) or 1.35
	self.RagdollDuration = tonumber(config.ragdollDuration) or 1.25
	self.KnockbackStrength = tonumber(config.knockbackStrength) or 35
	self.TrapLifetime = tonumber(config.trapLifetime) or 8
	self.TrapRadius = tonumber(config.trapRadius) or 3.25
	self.TrapPollInterval = tonumber(config.trapPollInterval) or 0.05
	self.Spin = 0
	self.SpinRate = tonumber(config.spinRate) or 18

	local template = getTemplate()
	if template then
		self.Visual = template:Clone()
	else
		local fallback = Instance.new("Part")
		fallback.Name = "BananaPeelProjectile"
		fallback.Size = Vector3.new(1.2, 0.2, 1)
		fallback.Material = Enum.Material.SmoothPlastic
		fallback.Color = Color3.fromRGB(245, 214, 46)
		self.Visual = fallback
	end

	self.Visual.Name = "BananaPeelProjectile"
	self.Root = getRoot(self.Visual)
	assert(self.Root, "BananaProjectile requires a BasePart root")

	self.Visual.Parent = getParentContainer()
	self.Maid:Add(self.Visual)
	setVisualState(self.Visual)
	self:updateVisual()

	if self.OwnerChar then
		local ownerHumanoid = self.OwnerChar:FindFirstChildOfClass("Humanoid")
		if ownerHumanoid then
			self.Maid:GiveTask(ownerHumanoid.Died:Connect(function()
				self:Destroy()
			end))
		end

		self.Maid:GiveTask(self.OwnerChar.AncestryChanged:Connect(function(_, parent)
			if not parent then
				self:Destroy()
			end
		end))
	end

	self.Elapsed = 0
	self.Maid:GiveTask(RunService.Heartbeat:Connect(function(dt)
		self:update(dt)
	end))

	return self
end

function module:updateVisual()
	local dir = self.Velocity.Magnitude > 0.05 and self.Velocity.Unit or self.Direction
	local cf = CFrame.lookAt(self.Position, self.Position + dir) * CFrame.Angles(0, 0, self.Spin)
	pivot(self.Visual, cf)
end

function module:update(dt: number)
	if self.Destroyed then
		return
	end

	dt = math.min(dt, 1 / 20)
	self.Elapsed += dt
	if self.Elapsed >= self.MaxFlightTime then
		self:Destroy()
		return
	end

	local prevPos = self.Position
	self.Velocity += self.Gravity * dt
	local nextPos = prevPos + self.Velocity * dt
	local delta = nextPos - prevPos

	if delta.Magnitude > 0 then
		local rayParams = RaycastParams.new()
		local filter = {self.Visual}
		if self.OwnerChar then
			table.insert(filter, self.OwnerChar)
		end
		local debrisFolder = workspace:FindFirstChild("Debris")
		if debrisFolder then
			table.insert(filter, debrisFolder)
		end
		local effectFolder = workspace:FindFirstChild("Effect")
		if effectFolder then
			table.insert(filter, effectFolder)
		end

		rayParams.FilterType = Enum.RaycastFilterType.Exclude
		rayParams.FilterDescendantsInstances = filter

		local result = workspace:Spherecast(prevPos, self.Radius, delta, rayParams)
		if result then
			local targetChar = getHumanoidModel(result.Instance)
			if targetChar and isValidTarget(self.OwnerChar, self.OwnerPlayer, targetChar) then
				applySlip(targetChar, result.Position, self.RagdollDuration, self.KnockbackStrength)
				self:Destroy()
				return
			end

			BananaTrap.new({
				ownerChar = self.OwnerChar,
				ownerPlayer = self.OwnerPlayer,
				position = result.Position,
				normal = result.Normal,
				lookVector = self.Velocity.Magnitude > 0.05 and self.Velocity.Unit or self.Direction,
				lifetime = self.TrapLifetime,
				radius = self.TrapRadius,
				pollInterval = self.TrapPollInterval,
				ragdollDuration = self.RagdollDuration,
				knockbackStrength = self.KnockbackStrength,
			})

			self:Destroy()
			return
		end
	end

	self.Position = nextPos
	self.Spin += dt * self.SpinRate
	self:updateVisual()
end

function module:Destroy()
	if self.Destroyed then
		return
	end
	self.Destroyed = true
	self.Maid:Destroy()
end

return module
