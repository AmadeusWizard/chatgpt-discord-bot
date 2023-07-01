import { APIEmbedField, ActionRowBuilder, EmbedBuilder, InteractionResponse, SlashCommandBuilder, StringSelectMenuBuilder } from "discord.js";
import { YoutubeTranscriptError } from "youtube-transcript";

import { countChatMessageTokens, getPromptLength } from "../conversation/utils/length.js";
import { GPTGenerationError, GPTGenerationErrorType } from "../error/gpt/generation.js";
import { Command, CommandInteraction, CommandResponse } from "../command/command.js";
import { ErrorResponse, ErrorType } from "../command/response/error.js";
import { YouTubeSubtitle, YouTubeVideo } from "../util/youtube.js";
import { LoadingIndicatorManager } from "../db/types/indicator.js";
import { OpenAIChatMessage } from "../openai/types/chat.js";
import { LanguageManager } from "../db/types/locale.js";
import { DatabaseInfo } from "../db/managers/user.js";
import { Response } from "../command/response.js";
import { YouTube } from "../util/youtube.js";
import { ComponentType } from "discord.js";
import { Utils } from "../util/utils.js";
import { Bot } from "../bot/bot.js";

/* How long a video can be for it to be usable for summarization, in seconds */
export const SUMMARIZE_MAX_VIDEO_DURATION: number = 15 * 60

interface SummaryType {
	/* Display name for this type */
	name: string;

	/* Description for this type */
	description: string;

	/* Description of this summary type for the model */
	prompt: string;
}

export interface SummaryPrompt {
	messages: OpenAIChatMessage[];
	tokens: number;
}

export const SummaryTypes: SummaryType[] = [
	{
		name: "Long",
		description: "Longer summary, going in-depth and into detail",

		prompt: "a pretty long text summary that's very detailed and going in-depth, keep it around 4-6 sentences long"
	},

	{
		name: "Medium",
		description: "An average summary, only keeping important things and some details",
		prompt: "a bit smaller text summary, only keeping important things & some details, 2-4 sentences long"
	},

	{
		name: "Short",
		description: "Very short 1-2 sentence summary, only keeping important information",
		prompt: "a short text summary, maximum 1-2 sentences and only keeping important information"
	},

	{
		name: "Bullet points",
		description: "Text summarized in bullet points",
		prompt: "bullet points, and no full sentences"
	}
]

export default class SummarizeCommand extends Command {
	constructor(bot: Bot) {
		super(bot, new SlashCommandBuilder()
			.setName("summarize")
			.setDescription("Summarize a YouTube video using ChatGPT")
			.addStringOption(builder => builder
				.setName("query")
				.setDescription("Which video to summarize")
				.setRequired(true)
				.setMaxLength(100)
			)
			.addStringOption(builder => builder
				.setName("type")
				.setRequired(false)
				.setDescription("How to summarize the text")
				.addChoices(...SummaryTypes.map(s => ({
					name: `${s.name} • ${s.description}`,
					value: s.name
				})))	
			)
		, {
			cooldown: {
				free: 5 * 60 * 1000,
				voter: 5 * 60 * 1000,
				subscription: 60 * 1000
			},

			restriction: [ "voter" ]
		});
	}

	private baseEmbed(video: YouTubeVideo): EmbedBuilder {
		return new EmbedBuilder()
			.setTitle(Utils.truncate(video.title, 256))
			.setURL(video.url)
			.setAuthor({ name: video.author.name, url: video.author.url })
			.setThumbnail(video.thumbnail)
			.setColor(this.bot.branding.color);
	}

	private statusUpdateResponse(db: DatabaseInfo, video: YouTubeVideo, message: string): Response {
		/* The user's loading indicator */
		const loadingEmoji: string = LoadingIndicatorManager.toString(
			LoadingIndicatorManager.getFromUser(this.bot, db.user)
		);

		return new Response()
			.addEmbed(
				this.baseEmbed(video)
					.setDescription(`${message} **...** ${loadingEmoji}`)
			);
	}

	private finalResponse(video: YouTubeVideo, type: SummaryType, summary: string): Response {
		const fields: APIEmbedField[] = [];

		if (type.name !== SummaryTypes[0].name) fields.push({
			name: "Summarized in",
			value: type.name
		});

		return new Response()
			.addEmbed(
				this.baseEmbed(video)
					.setDescription(summary)
					.addFields(fields)
			);
	}

	private buildSummarizerPrompt(db: DatabaseInfo, video: YouTubeVideo, subtitles: YouTubeSubtitle[], type: SummaryType): SummaryPrompt {
		/* Final list of chat messages */
		const messages: OpenAIChatMessage[] = [];

		/* Language to write the summary in */
		const targetLanguage: string = LanguageManager.modelLanguageName(this.bot, db.user);

		messages.push({
			content: `You will be sent a transcript of a YouTube video titled ${video.title} uploaded by ${video.author.name}, with the description """${Utils.truncate(video.description, 200)}""". You must summarize it${targetLanguage !== "English" ? ` in the language "${targetLanguage}",` : ""} in ${type.prompt}. In the summary, only reference the video and not the transcript sent by the user."`,
			role: "system"
		});

		/* Now, merge all the subtitles into a single message. */
		const str: string = subtitles.map(s => s.content).join(" ");

		messages.push({
			content: str,
			role: "assistant"
		});

		/* How many tokens the prompt uses in total */
		const tokens: number = countChatMessageTokens(messages);

		if (tokens > 4000 && subtitles.length === 0) {
			throw new GPTGenerationError({
				type: GPTGenerationErrorType.Length
			});

		/* If the prompt uses too many tokens, re-run the prompt builder with a lower amount of subtitles. */
		} else if (tokens > 4000) {
			const arr: YouTubeSubtitle[] = subtitles;
			arr.pop();

			return this.buildSummarizerPrompt(db, video, arr, type);
		}

		return {
			messages, tokens
		};
	}

    public async run(interaction: CommandInteraction, db: DatabaseInfo): CommandResponse {
		/* Query of the YouTube video to use */
		const query: string = interaction.options.getString("query", true).trim();

		if (query.length === 0) return new ErrorResponse({
			interaction, command: this, message: "You specified an invalid YouTube query"
		});

		const moderation = await this.bot.moderation.check({
			db, user: interaction.user, content: query, source: "youTubeQuery"
		});

		/* If the message was flagged, send a warning message. */
		if (moderation.blocked) return await this.bot.moderation.message({
            result: moderation, name: "The YouTube search query"
        });

		await interaction.deferReply().catch(() => {});

		/* How to summarize the video */
		const summaryName: string | null = interaction.options.getString("type");
		const type: SummaryType = summaryName !== null ? SummaryTypes.find(s => s.name === summaryName)! : SummaryTypes[0];

		/* Search for the given query on YouTube. */
		const results: YouTubeVideo[] = (await YouTube.search({ query, max: 50 }))
			.filter(video => video.duration.seconds <= SUMMARIZE_MAX_VIDEO_DURATION)
			.slice(undefined, 25);
		
		if (results.length === 0) return new ErrorResponse({
			interaction, command: this, message: "There are no search results for the specified query"
		});

		const builder = new StringSelectMenuBuilder()
			.setCustomId("video-selector")
			.setPlaceholder("Choose a video...")
			.addOptions(results.map(video => ({
				label: Utils.truncate(video.title, 100),
				emoji: "<:youtube:1103448388055334944>",
				description: `by ${video.author.name} • ${video.duration.timestamp}`,
				value: video.videoId
			})));

        const reply: InteractionResponse | null = await new Response()
			.addEmbed(builder => builder
				.setDescription("*Choose a video from the list to summarize 📝*")
				.setColor(this.bot.branding.color)
			)
			.addComponent(ActionRowBuilder<StringSelectMenuBuilder>, new ActionRowBuilder().addComponents(builder))
		.send(interaction) as InteractionResponse | null;

		if (reply === null) return;

		try {
			/* Create the message component collector. */
			const selection = await reply.awaitMessageComponent({
				componentType: ComponentType.StringSelect,
				filter: i => i.user.id === interaction.user.id && i.customId === "video-selector",
				time: 120 * 1000
			});

			/* ID of the video */
			const id: string = selection.values[0];

			/* Get the selected video from the list of search results. */
			const video: YouTubeVideo = results.find(v => v.videoId === id)!;

			try {
				/* And now, try to fetch the subtitles of the selected video. */
				const subtitles = await YouTube.subtitles({ url: id });

				if (subtitles.length === 0) return new ErrorResponse({
					interaction: selection, command: this, message: `The video **${video.title}** doesn't have subtitles`, emoji: "😕"
				});

				/* Merge all the subtitles into a single prompt. */
				const prompt = this.buildSummarizerPrompt(db, video, subtitles, type);
				this.statusUpdateResponse(db, video, "Summarizing").send(interaction);

				/* Generate the summarization result using ChatGPT. */
				const raw = await this.bot.turing.openAI({
					messages: prompt.messages, model: "gpt-3.5-turbo-0613",
					temperature: 0.6, maxTokens: 500
				});

				/* Summary of the subtitles, by ChatGPT */
				const summary: string = raw.response.message.content;

				/* How many tokens the final summary uses up */
				const tokens: number = getPromptLength(summary);

				await this.bot.db.plan.expenseForSummary(db, video, prompt, tokens);
				return this.finalResponse(video, type, summary);

			} catch (error) {
				if (error instanceof GPTGenerationError && error.options.data.type === GPTGenerationErrorType.Length) return new ErrorResponse({
					interaction: selection, command: this, type: ErrorType.Error, message: "The video's subtitles are too large to summarize", emoji: "😕"
				});

				if (error instanceof YoutubeTranscriptError || (error as Error).message.includes("YoutubeTranscript")) return new ErrorResponse({
					interaction: selection, command: this, message: `The video **${video.title}** doesn't have subtitles`, emoji: "😕"
				});

				return await this.bot.error.handle({
					error, title: "Failed to fetch video subtitles", notice: "It seems like something went wrong while trying to summarize the subtitles for the video."
				});
			}

		/* The user didn't interact with the select menu, ... */
		} catch (_) {}
    }
}