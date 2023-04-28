import { SlashCommandBuilder } from "discord.js";

import { Command, CommandResponse } from "../command/command.js";
import { Response } from "../command/response.js";
import { Bot } from "../bot/bot.js";

export default class SupportCommand extends Command {
	constructor(bot: Bot) {
		super(bot, new SlashCommandBuilder()
			.setName("chat")
			.setDescription("Deprecated command; ping @ChatGPT using your prompt instead")
			.addStringOption(builder => builder
				.setName("prompt")
				.setRequired(false)
				.setDescription("Deprecated command; ping @ChatGPT using your prompt instead")
		));
	}

    public async run(): CommandResponse {
        return new Response()
			.addEmbed(builder => builder
				.setDescription(`\`/chat\` has been removed in favor of mentioning <@${this.bot.client.user!.id}> with your prompt directly. This allows you to do multi-line prompts, attach text attachments & *images* (premium-only ✨) and more to come in the future.`)
				.addFields([
					{
						name: "How can I use it?",
						value: `To use the bot, simply ping <@${this.bot.client.user!.id}> with your prompt in a message.\ne.g. \`@${this.bot.client.user!.username} What is your name?\``
					},

					{
						name: "How can I change the model?",
						value: `You can either run \`/tone\` beforehand to select one, or you can press the first button below a generated message to choose the model from a dropdown menu.`
					}
				])
				.setColor("Orange")
			)
			.setEphemeral(true);
    }
}