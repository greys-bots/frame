const { Collection } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { pageBtns: PAGE } = require('../extras');

const rest = new REST({ version: '9' }).setToken(process.env.TOKEN);

class InteractionHandler {
	menus = new Collection();

	constructor(bot, path) {
		this.bot = bot;
		this.commandPath = path;

		bot.on('interactionCreate', (interaction) => {
			this.handle(interaction);
		})

		bot.once('ready', async () => {
			console.log('Loading app commands...');
			await this.load();
			console.log('App commands loaded.')
		})
	}

	async load() {
		var slashCommands = new Collection(); // actual commands, with execute data
		var slashData = new Collection(); // just what gets sent to discord
		var devOnly = new Collection(); // slashData: dev edition

		var files = this.bot.utils.recursivelyReadDirectory(this.commandPath);

		for(var f of files) {
			var path_frags = f.replace(this.commandPath, "").split(/(?:\\|\/)/); // get fragments of path to slice up
			var mods = path_frags.slice(1, -1); // the module names (folders SHOULD = mod name)
			var file = path_frags[path_frags.length - 1]; // the actual file name
			if(file == '__mod.js') continue; // ignore mod files, only load if command exists
			delete require.cache[require.resolve(f)]; // for reloading
			
			var command = require(f)(this.bot, this.bot.stores); // again, full command data

			// if the commands are part of modules,
			// then we need to nest them into those modules for parsing
			if(mods.length) {
				let curmod; // current FULL module data
				for(var i = 0; i < mods.length; i++) {
					var group; // the mod we're using. basically curmod but for this loop
					if(!curmod) {
						// start of loop, set up group and current mod
						curmod = slashCommands.get(mods[i]);
						group = curmod;
					} else {
						// just get the group out of the curmod's subcommands
						group = curmod.subcommands.get(mods[i]);
					}

					if(!group) {
						// no group data? we need to create it
						var mod;
						delete require.cache[require.resolve(this.commandPath + `/${mods.slice(0, i + 1).join("/")}/__mod.js`)];
						mod = require(this.commandPath + `/${mods.slice(0, i + 1).join("/")}/__mod.js`)(this.bot, this.bot.store);
						group = mod;
						group.type = group.type ?? 1;

						if(!curmod) {
							// start of loop again, also means we can
							// safely set this as a top-level command in our collections
							slashCommands.set(mod.name, group);
						} else {
							// otherwise it belongs nested below the current module data
							curmod.addSubcommand(group);
						}
					}

					// set the current mod to the group so we have proper nesting for
					// the next group or command
					curmod = group;
				}

				// inherit permissions from parent module
				command.permissions = command.permissions ?? curmod.permissions;
				command.opPerms = command.opPerms ?? curmod.opPerms;
				command.guildOnly = command.guildOnly ?? curmod.guildOnly;

				curmod.addSubcommand(command) // nest the command
			} else {
				// no mods? just make it top-level
				slashCommands.set(command.name, command);
			}
		}

		this.bot.slashCommands = slashCommands; // for safe keeping
		slashData = slashCommands.map(s => s.transform());

		// all of below is just sending it off to discord
		try {
			if(!this.bot.application?.owner) await this.bot.application?.fetch();

			var cmds = slashData.map(d => d);
			var dcmds = devOnly.map(d => d);
			if(process.env.COMMAND_GUILD == process.env.DEV_GUILD) {
				cmds = cmds.concat(dcmds);
				await rest.put(
					Routes.applicationGuildCommands(this.bot.application.id, process.env.COMMAND_GUILD),
					{ body: cmds },
				);

				await rest.put(
					Routes.applicationCommands(this.bot.application.id),
					{ body: [] }
				)
			} else {
				if(process.env.COMMAND_GUILD) {
					await rest.put(
						Routes.applicationGuildCommands(this.bot.application.id, process.env.COMMAND_GUILD),
						{ body: cmds },
					);

					await rest.put(
						Routes.applicationCommands(this.bot.application.id),
						{ body: [] }
					)
				} else {
					await rest.put(
						Routes.applicationCommands(this.bot.application.id),
						{ body: cmds },
					);
				}
	
				await rest.put(
					Routes.applicationGuildCommands(this.bot.application.id, process.env.DEV_GUILD),
					{ body: dcmds },
				);
			}
			return;
		} catch(e) {
			console.log(e);
			return Promise.reject(e);
		}
	}

	async handle(ctx) {
		if(ctx.isAutocomplete()) this.handleAuto(ctx);
		if(ctx.isCommand() || ctx.isContextMenu()) this.handleCommand(ctx);
		if(ctx.isButton()) this.handleButtons(ctx);
		if(ctx.isSelectMenu()) this.handleSelect(ctx);
	}

	parse(ctx) {
		var long = "";
		var cmd = this.bot.slashCommands.get(ctx.commandName);
		if(!cmd) return;
		long += cmd.name ?? cmd.name;

		if(ctx.options.getSubcommandGroup(false)) {
			cmd = cmd.subcommands.get(ctx.options.getSubcommandGroup());
			if(!cmd) return;
			long += ` ${cmd.name}`;
			var opt = ctx.options.getSubcommand(false);
			if(opt) {
				cmd = cmd.subcommands.get(opt);
				if(cmd) long += ` ${cmd.name}`;
			} else return;
		} else if(ctx.options.getSubcommand(false)) {
			cmd = cmd.subcommands.get(ctx.options.getSubcommand());
			if(!cmd) return;
			long += ` ${cmd.name}`;
		}

		if(cmd) cmd.long = long;
		return cmd;
	}

	async handleCommand(ctx) {
		var cmd = this.parse(ctx);
		if(!cmd) return;

		var cfg;
		if(ctx.guild && ctx.client.stores?.configs) cfg = await ctx.client.stores.configs.get(ctx.guild.id);

		var check = this.checkPerms(cmd, ctx, cfg);
		if(!check) return await ctx.reply({
			content: "You don't have permission to use this command!",
			ephemeral: true
		});
		if(cmd.guildOnly && !ctx.guildId) return await ctx.reply({
			content: "That command is guild only!",
			ephemeral: true
		})
		
		try {
			var res = await cmd.execute(ctx);
		} catch(e) {
			console.error(e);
			if(ctx.replied) return await ctx.followUp({content: "Error:\n" + e.message, ephemeral: true});
			else return await ctx.reply({content: "Error:\n" + e.message, ephemeral: true});
		}

		if(!res) return;

		var type;
		if(ctx.deferred) type = 'editReply';
		else type = ctx.replied ? 'followUp' : 'reply'; // ew gross but it probably works
		switch(typeof res) {
			case 'string':
				return await ctx[type]({content: res, ephemeral: cmd.ephemeral ?? false})
			case 'object':
				if(Array.isArray(res)) {
					var reply = {
						embeds: [res[0]],
						ephemeral: cmd.ephemeral ?? false
					};
					if(!res[1]) return await ctx[type](reply);

					reply = {
						...reply,
						components: [
							{
								type: 1,
								components: PAGE(1, res.length)
							}
						]
					}
					await ctx[type](reply);
					var message = await ctx.editReply(reply);

					var menu = {
						user: ctx.user.id,
						interaction: ctx,
						data: res,
						index: 0,
						timeout: setTimeout(() => {
							if(!this.menus.get(message.id)) return;
							this.menus.delete(message.id);
						}, 5 * 60000),
						handle: (ctx) => this.paginate(menu, ctx)
					}

					this.menus.set(message.id, menu);

					return;
				}

				return await ctx[type]({...res, ephemeral: (res.ephemeral ?? cmd.ephemeral) ?? false})
		}
	}

	async handleButtons(ctx) {
		var {message} = ctx;
		var menu = this.menus.get(message.id);
		if(!menu) return;

		menu.handle(ctx);
	}

	async handleSelect(ctx) {
		var {message} = ctx;
		var menu = this.menus.get(message.id);
		if(!menu) return;

		menu.handle(ctx);
	}

	async handleAuto(ctx) {
		var cmd = this.parse(ctx);
		if(!cmd) return;

		var result = await cmd.auto(ctx);
		return await ctx.respond(result ?? []);
	}

	checkPerms(cmd, ctx, cfg) {
		if(cmd.ownerOnly && ctx.user.id !== process.env.OWNER)
			return false;
		if(cmd.guildOnly && !ctx.member) return false; // pre-emptive in case of dm slash cmds

		if(!cmd.permissions?.length) return true; // no perms also means no opPerms
		if(ctx.member.permissions.has(cmd.permissions))
			return true;

		var found = this.findOpped(ctx.member ?? ctx.user, cfg?.opped)
		if(found && cmd.opPerms){			
			return (cmd.opPerms.filter(p => found.perms.includes(p))
					.length == cmd.opPerms.length);
		}

		return false;
	}

	findOpped(user, opped) {
		if(!opped || !user) return;

		var f = opped.users?.find(u => u.id == user.id);
		if(f) return f;

		if(user.roles) {
			f = opped.roles.find(r => user.roles.cache.has(r.id));
			if(f) return f;
		}

		return;
	}

	async paginate(menu, ctx) {
		var {data} = menu;
		var {customId: id} = ctx;

		switch(id) {
			case 'first':
				menu.index = 0;
				break;
			case 'prev':
				if(menu.index == 0) {
					menu.index = data.length - 1;
				} else menu.index = (menu.index - 1) % data.length;
				break;
			case 'next':
				menu.index = (menu.index + 1) % data.length;
				break;
			case 'last':
				menu.index = data.length -1;
				break;
		}

		await ctx.update({
			embeds: [data[menu.index]],
			components: [{
				type: 1,
				components: PAGE(menu.index + 1, data.length)
			}]
		})
	}
}

module.exports = (bot, path) => new InteractionHandler(bot, path);