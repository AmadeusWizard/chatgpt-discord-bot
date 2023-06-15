import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";

import { Command, CommandInteraction, CommandResponse } from "../command/command.js";
import { ErrorResponse, ErrorType } from "../command/response/error.js";
import { Conversation } from "../conversation/conversation.js";
import { MaxImagePromptLength } from "./imagine.js";
import { DatabaseInfo } from "../db/managers/user.js";
import { TuringImageOptions } from "../turing/api.js";
import { Response } from "../command/response.js";
import { GPTAPIError } from "../error/gpt/api.js";
import { Bot } from "../bot/bot.js";

export default class DallECommand extends Command {
	constructor(bot: Bot) {
		super(bot, new SlashCommandBuilder()
			.setName("dall-e")
			.setDescription("Generate images using DALL·E 2 by OpenAI")

			.addStringOption(builder => builder
				.setName("prompt")
				.setDescription("The possibilities are endless... 💫")
				.setMaxLength(MaxImagePromptLength)
				.setRequired(true)
			)

			.addIntegerOption(builder => builder
				.setName("count")
				.setDescription("How many images to generate")
				.setMinValue(1)
				.setMaxValue(2)
				.setRequired(false)
			)
		, {
			cooldown: {
				free: 5 * 60 * 1000,
				voter: 4 * 60 * 1000,
				subscription: 2 * 60 * 1000
			},

			synchronous: true
		});
	}

    public async run(interaction: CommandInteraction, db: DatabaseInfo): CommandResponse {
		const conversation: Conversation = await this.bot.conversation.create(interaction.user);

		/* Which prompt to use for generation */
		const prompt: string = interaction.options.getString("prompt", true);

		/* How many images to generate */
		const count: number = interaction.options.getInteger("count") ?? 1;

		/* Defer the reply, as this might take a while. */
		await interaction.deferReply().catch(() => {});

		const moderation = await this.bot.moderation.checkImagePrompt({
			db, user: interaction.user, content: prompt, nsfw: false, model: "dall-e"
		});

		/* If the message was flagged, send a warning message. */
		if (moderation.blocked) return await this.bot.moderation.message({
            result: moderation, name: "Your image prompt"
        });

		/* Video generation options */
		const options: TuringImageOptions = {
			prompt, count
		};

		try {
			/* Try to generate the DALL-E images. */
			const result = await conversation.manager.bot.turing.generateImages(options);

			/* Increment the user's usage. */
			await this.bot.db.users.incrementInteractions(db, "images");

			await this.bot.db.metrics.changeImageMetric({
				models: {
					"dall-e": "+1"
				},

				counts: {
					[count]: "+1"
				}
			});

			await this.bot.db.plan.expenseForDallEImage(db, count);

			const response =  new Response()
				.setContent(`**${prompt}** — *${(result.duration / 1000).toFixed(1)} seconds*`)
				.addEmbed(builder => builder
					.setTitle("This command is going soon ... 🧹")
					.setDescription(`\`/dall-e\` used an outdated & worse model for image generation, compared to \`/mj\` and \`/imagine\`. \`/mj\` offers **beautiful & free** image generation; \`/imagine\` gives you access to **lots of models** for **free**. *\`/dall-e\` will be removed soon, in favor of the better alternatives mentioned.*`)
					.setColor("Orange")
				);

			result.images.forEach((image, index) => response.addAttachment(
				new AttachmentBuilder(image.buffer).setName(`result-${index}.png`)
			));

			return response;
			
		} catch (error) {
			if (error instanceof GPTAPIError && error.options.data.code === 400) return new ErrorResponse({
				interaction, command: this,
				message: "Your image prompt was blocked by **OpenAI**'s filters. *Make sure to follow their [usage policies](https://openai.com/policies/usage-policies); otherwise we may have to take moderative actions*.",
				color: "Orange", emoji: null
			});

			return await this.bot.error.handle({
				title: "Failed to generate DALL·E images", notice: "It seems like we encountered an error while trying to generate DALL·E images for you.", error
			});
		}
    }
}