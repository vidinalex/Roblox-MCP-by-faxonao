local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Maid = require(ReplicatedStorage.Modules.Classes.Maid)

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
		part.AssemblyLinearVelocity = Vector3.zero
		part.AssemblyAngularVelocity = Vector3.zero
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
	self.Radius = tonumber(config.radius) or 3.25
	self.PollInterval = tonumber(config.pollInterval) or 0.05
	self.Lifetime = tonumber(config.lifetime) or 8
	self.RagdollDuration = tonumber(config.ragdollDuration) or 1.25
	self.KnockbackStrength = tonumber(config.knockbackStrength) or 35

	local template = getTemplate()
	if template then
		self.Visual = template:Clone()
	else
		local fallback = Instance.new("Part")
		fallback.Name = "BananaPeelTrap"
		fallback.Size = Vector3.new(1.35, 0.2, 1.1)
		fallback.Material = Enum.Material.SmoothPlastic
		fallback.Color = Color3.fromRGB(245, 214, 46)
		self.Visual = fallback
	end

	self.Visual.Name = "BananaPeelTrap"
	self.Root = getRoot(self.Visual)
	assert(self.Root, "BananaTrap requires a BasePart root")

	self.Visual.Parent = getParentContainer()
	self.Maid:Add(self.Visual)
	setVisualState(self.Visual)

	local normal = config.normal
	if typeof(normal) ~= "Vector3" or normal.Magnitude < 0.05 then
		normal = Vector3.new(0, 1, 0)
	end
	normal = normal.Unit

	local look = config.lookVector
	if typeof(look) ~= "Vector3" or look.Magnitude < 0.05 then
		look = Vector3.new(0, 0, 1)
	end
	look = look.Unit

	local planarLook = look - normal * look:Dot(normal)
	if planarLook.Magnitude < 0.05 then
		local fallbackLook = Vector3.new(1, 0, 0) - normal * Vector3.new(1, 0, 0):Dot(normal)
		if fallbackLook.Magnitude < 0.05 then
			fallbackLook = Vector3.new(0, 0, 1) - normal * Vector3.new(0, 0, 1):Dot(normal)
		end
		planarLook = fallbackLook
	end
	planarLook = planarLook.Unit

	local right = planarLook:Cross(normal).Unit
	local up = normal
	local back = -planarLook
	local cf = CFrame.fromMatrix(config.position + normal * 0.5, right, up, back)
	pivot(self.Visual, cf)

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

	local elapsed = 0
	self.Maid:GiveTask(RunService.Heartbeat:Connect(function(dt)
		elapsed += dt
		if elapsed < self.PollInterval then
			return
		end
		elapsed = 0

		local overlapParams = OverlapParams.new()
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

		overlapParams.FilterType = Enum.RaycastFilterType.Exclude
		overlapParams.FilterDescendantsInstances = filter

		local seen = {}
		local parts = workspace:GetPartBoundsInRadius(self.Root.Position, self.Radius, overlapParams)
		for _, part in ipairs(parts) do
			local targetChar = getHumanoidModel(part)
			if targetChar and not seen[targetChar] then
				seen[targetChar] = true
				if isValidTarget(self.OwnerChar, self.OwnerPlayer, targetChar) then
					if applySlip(targetChar, self.Root.Position, self.RagdollDuration, self.KnockbackStrength) then
						self:Destroy()
						return
					end
				end
			end
		end
	end))

	self.Maid:GiveTask(task.delay(self.Lifetime, function()
		self:Destroy()
	end))

	return self
end

function module:Destroy()
	if self.Destroyed then
		return
	end
	self.Destroyed = true
	self.Maid:Destroy()
end

return module
