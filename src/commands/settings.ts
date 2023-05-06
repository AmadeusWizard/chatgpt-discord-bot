import { SlashCommandBuilder, EmbedBuilder, AutocompleteInteraction, CacheType, CommandInteractionOption, SlashCommandSubcommandBuilder } from "discord.js";

import { Command, CommandInteraction, CommandOptionChoice, CommandResponse } from "../command/command.js";
import { Response } from "../command/response.js";

import { AutocompleteChoiceSettingsOption, ChoiceSettingsOption, SettingKeyAndCategory, SettingsCategory, SettingsCategoryName, SettingsName } from "../db/managers/settings.js";
import { DatabaseInfo, DatabaseUser } from "../db/managers/user.js";
import { ErrorResponse } from "../command/response/error.js";
import { SettingsOption } from "../db/managers/settings.js";
import { Emoji } from "../util/emoji.js";
import { Bot } from "../bot/bot.js";

export default class SettingsCommand extends Command {
    constructor(bot: Bot) {
		const builder: SlashCommandBuilder =
			new SlashCommandBuilder()
				.setName("settings")
				.setDescription("Customize the bot to your liking");

		for (const category of bot.db.settings.categories()) {
			/* All options for this category */
			const options: SettingsOption[] = bot.db.settings.options(category);

			const sub: SlashCommandSubcommandBuilder = new SlashCommandSubcommandBuilder()
				.setName(category.type)
				.setDescription(`Change or view ${category.name.toString()} settings ${category.emoji.fallback}`);

			/* Add the options to the /settings sub-command. */
			options.forEach(o => o.addToCommand(bot, sub));
			builder.addSubcommand(sub);
		}

        super(bot, builder, { cooldown: 5 * 1000 });
    }

	public format(db: DatabaseUser, category: SettingsCategory, changes: Partial<Record<SettingsName, any>>): Response {
		const embed: EmbedBuilder = new EmbedBuilder()
			.setTitle("Settings ⚙️")
			.setColor(Object.values(changes).length > 0 ? "Orange" : this.bot.branding.color);

		for (const option of this.bot.db.settings.options(category)) {
			const key = this.bot.db.settings.settingsString(option);

			/* Whether this option was modified */
			const wasModified: boolean = changes[key] != undefined;

			const original = this.bot.db.settings.get(db, key);
			const modified = changes[key];

			embed.addFields({
				name: `${option.data.name} ${Emoji.display(option.data.emoji, true)} · *${option.data.description}*`,
				value: wasModified ? `*${option.display(this.bot, modified)}*` : option.display(this.bot, original)
			});
		}

		if (Object.keys(changes).length === 0) embed.setFooter({ text: "Change your settings, by specifying changes you want to make when running /settings." })
		return new Response().addEmbed(embed);
	}

	public async complete(interaction: AutocompleteInteraction<CacheType>): Promise<CommandOptionChoice<string | number>[]> {
		const param: CommandInteractionOption | null = interaction.options.data[0]?.options?.filter(o => o.focused)[0] ?? null;
		if (param === null) return [];

		/* Category of this setting */
		const categoryName: SettingsCategoryName = interaction.options.getSubcommand(true) as SettingsCategoryName;

		/* Value of the specified argument */
		const value: string = param.value as string;

		/* Find the corresponding settings option. */
		const option: AutocompleteChoiceSettingsOption | null =
			this.bot.db.settings.settingsOption(`${categoryName}:${param.name}`) as AutocompleteChoiceSettingsOption
			?? null;

		/* Try to complete this request. */
		return option.complete(this.bot, interaction, value);
	}

    public async run(interaction: CommandInteraction, { user, guild }: DatabaseInfo): CommandResponse {
		/* Whether the user has their own Premium subscription */
		const premium: boolean = this.bot.db.users.canUsePremiumFeatures({ user, guild });

		/* Category of this setting */
		const categoryName: SettingsCategoryName = interaction.options.getSubcommand(true) as SettingsCategoryName;
		const category: SettingsCategory = this.bot.db.settings.categories().find(c => c.type === categoryName)!;

		/* All changes done by the user */
		const changes: Partial<Record<SettingKeyAndCategory, any>> = {};

		for (const option of this.bot.db.settings.options(category)) {
			/* Get the value specified by the user. */
			const param = interaction.options.get(option.key, false);
			if (param == undefined || param.value == undefined) continue;

			/* If the chosen option is Premium-only, show a notice to the user. */
			if (option instanceof ChoiceSettingsOption) {
				/* Chosen choice from the list */
				const chosen = option.data.choices.find(c => c.value === param.value) ?? null;

				if (chosen === null) return new ErrorResponse({
					interaction, message: `You specified an invalid option for setting **${option.data.name}**`, emoji: Emoji.display(option.data.emoji, true).toString()
				});
			
				if (chosen.premium && !premium) return new Response()
					.addEmbed(builder => builder
						.setDescription(`✨ The choice **${chosen.name}** for \`${option.data.name}\` is restricted to **Premium** users.\n**Premium** *also includes further benefits, view \`/premium info\` for more*. ✨`)
						.setColor("Orange")
					)
					.setEphemeral(true);
				
			} else if (option instanceof AutocompleteChoiceSettingsOption) {
				/* Whether the choice for the command is actually valid */
				const valid: boolean = option.valid(this.bot, param.value as string);

				if (!valid) return new ErrorResponse({
					interaction, message: `You specified an invalid option for setting **${option.data.name}**`, emoji: Emoji.display(option.data.emoji, true).toString()
				});
			}

			const key = this.bot.db.settings.settingsString(option);
			if (this.bot.db.settings.get(user, key) != param.value) changes[key] = param.value;
		}

		/* Apply the modified settings, if any were actually changed. */
		if (Object.values(changes).length > 0) await this.bot.db.settings.apply(user, changes);

		return this.format(user, category, changes).setEphemeral(true);
    }
}