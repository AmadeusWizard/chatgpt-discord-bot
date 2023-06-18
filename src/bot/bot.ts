import { ActivityType, Awaitable, basename, Client, GatewayIntentBits, Options, Partials } from "discord.js";
import { ClusterClient, getInfo, IPCMessage, messageType } from "discord-hybrid-sharding";
import EventEmitter from "events";
import chalk from "chalk";

import { ImageDescriptionManager } from "../image/description.js";
import { ConversationManager } from "../conversation/manager.js";
import { ModerationManager } from "../moderation/moderation.js";
import { InteractionManager } from "../interaction/manager.js";
import { ReplicateManager } from "../chat/other/replicate.js";
import { WebhookManager } from "../conversation/webhook.js";
import { StatusIncidentType } from "../util/statuspage.js";
import { BotClusterManager, BotData } from "./manager.js";
import { ClusterDatabaseManager } from "../db/cluster.js";
import { chooseStatusMessage } from "../util/status.js";
import { CommandManager } from "../command/manager.js";
import { ErrorManager } from "../moderation/error.js";
import { ImageManager } from "../image/manager.js";
import { RunPodManager } from "../runpod/api.js";
import { ShardLogger } from "../util/logger.js";
import { ConfigBranding } from "../config.js";
import { VoteManager } from "../util/vote.js";
import { TuringAPI } from "../turing/api.js";
import { TenorAPI } from "../util/tenor.js";
import { GitCommit } from "../util/git.js";
import { Event } from "../event/event.js";
import { Utils } from "../util/utils.js";
import { StrippedApp } from "../app.js";
import { TaskManager } from "./task.js";

export type BotStatusType = StatusIncidentType | "maintenance"

export interface BotStatus {
    /* Current status of the bot */
    type: BotStatusType;

    /* Since when this status is active */
    since: number;

    /* Additional notice message for the current status */
    notice?: string;
}

export interface BotStatistics {
    /* Total amount of servers the bot is on */
    guildCount: number;

    /* Total amount of users in the database */
    databaseUsers: number;

    /* Total amount of Discord users */
    discordUsers: number;

    /* Total amount of conversations in the database */
    conversations: number;

    /* RAM usage, in bytes */
    memoryUsage: number;

    /* Discord ping, in milliseconds */
    discordPing: number;

    /* Latest Git commit */
    commit: GitCommit | null;
}

interface BotSetupStep {
    /* Name of the setup step */
    name: string;

    /* Only execute the step if this function evaluates to `true` */
    check?: () => Awaitable<boolean>;

    /* Function to execute for the setup step */
    execute: () => Awaitable<any>;
}

export type BotDiscordClient = Client<true> & {
    cluster: ClusterClient<Client<true>>;
    bot: Bot;
}

export declare interface Bot {
    on(event: "started", listener: () => void): this;
}

export class Bot extends EventEmitter {
    /* Stripped-down app data */
    public app: StrippedApp;

    /* Data about this shard */
    public data: BotData;

    /* Logger instance, for the shard */
    public readonly logger: ShardLogger;

    /* Scheduled task manager */
    public readonly task: TaskManager;

    /* Command manager, in charge of registering commands & handling interactions */
    public readonly command: CommandManager;

    /* Interaction manager, in charge of handling various other interactions (buttons, modals, etc.) */
    public readonly interaction: InteractionManager;

    /* Database manager, in charge of managing the database connection & updates */
    public readonly db: ClusterDatabaseManager;

    /* Turing API manager */
    public readonly turing: TuringAPI;

    /* Conversation & session manager, in charge of managing conversations with the bot */
    public readonly conversation: ConversationManager;

    /* Moderation handler; for all stuff related to moderation & logging */
    public readonly moderation: ModerationManager;

    /* Error handler; for saving & handling errors that occur */
    public readonly error: ErrorManager;

    /* Web-hook manager; for custom characters with the bot */
    public readonly webhook: WebhookManager;

    /* Image description manager; in charge of describing images & detecting text */
    public readonly description: ImageDescriptionManager;

    /* RunPod AI manager; in charge of executing RunPod model requests */
    public readonly runpod: RunPodManager;

    /* Replicate API manager */
    public readonly replicate: ReplicateManager;

    /* Tenor API client */
    public gif: TenorAPI;

    /* top.gg API manager */
    public readonly vote: VoteManager;

    /* Stable Horde image generation manager; in charge of sending requests & keeping track of images */
    public readonly image: ImageManager;

    /* Discord client */
    public readonly client: BotDiscordClient;

    /* Since when this instance has been running */
    public since: number;

    /* Various statistics about the bot */
    public statistics: BotStatistics;

    constructor() {
        super();

        this.data = null!;
        this.app = null!;
        this.since = -1;

        /* Set some placeholder statistics. */
        this.statistics = {
            conversations: 0,
            discordPing: 0,
            memoryUsage: 0,
            guildCount: 0,
            discordUsers: 0,
            databaseUsers: 0,
            commit: null
        };

        /* Set up various classes & services. */
        this.description = new ImageDescriptionManager(this);
        this.conversation = new ConversationManager(this);
        this.interaction = new InteractionManager(this);
        this.moderation = new ModerationManager(this);
        this.replicate = new ReplicateManager(this);
        this.db = new ClusterDatabaseManager(this);
        this.webhook = new WebhookManager(this);
        this.command = new CommandManager(this);
        this.runpod = new RunPodManager(this);
        this.error = new ErrorManager(this);
        this.logger = new ShardLogger(this);
        this.image = new ImageManager(this);
        this.turing = new TuringAPI(this);
        this.vote = new VoteManager(this);
        this.task = new TaskManager(this);
        this.gif = new TenorAPI(this);
        
        this.client = new Client({
            shards: getInfo().SHARD_LIST,
            shardCount: getInfo().TOTAL_SHARDS,

			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
                GatewayIntentBits.DirectMessages
			],

            partials: [
                Partials.GuildMember,
                Partials.Channel,
                Partials.User
            ],

            makeCache: Options.cacheWithLimits({
                ...Options.DefaultMakeCacheSettings,

                ReactionManager: 0,
                MessageManager: 0,
                
                GuildMemberManager: {
                    keepOverLimit: (member) => member.id === this.client.user.id,
                    maxSize: 200
                }
            }),

            presence: {
                status: "idle",

                activities: [
                    {
                        name: "Reloading ...",
                        type: ActivityType.Playing
                    }
                ]
            }
        }) as typeof this.client;

        /* Add the cluster client to the Discord client. */
        this.client.cluster = new ClusterClient(this.client);
        this.client.bot = this;

        /* Exit the process, when an unhandled promise was rejected. */
        process.on("unhandledRejection", reason => {
            this.logger.error(reason);
            this.stop(1);
        });

        process.on("uncaughtException", error => {
            this.logger.error(error);
            this.stop(1);
        });
    }

    /**
     * Wait for the bot manager to send the StrippedApp data to this child process.
     * @returns Stripped app data
     */
    private async waitForData(): Promise<void> {
        return new Promise(resolve => {
            /* Wait for a message to get sent to the process. */
            this.client.cluster.on("message", ((message: IPCMessage & { _type: messageType }) => {
                if (message._type !== 2) return;
                if (!message.content || (message.content as BotData).id == undefined) return;

                /* As this is the only data ever sent to the process, simply parse everything as stripped app data. */
                const data: BotData = message.content as BotData;

                this.app = data.app;
                this.data = data;

                resolve();
            }) as any);
        });
    }

    private waitForDone(): void {
        this.client.cluster.on("message", ((message: IPCMessage & { _type: messageType }) => {
            if (message.content === "done") {
                this.since = Date.now();
                this.emit("started");
            }
        }) as any);
    }

    /**
     * Set up the Discord client & all related services.
     */
    public async setup(): Promise<void> {
        /* If the bot was started in maintenance mode, wait until the `ready` event gets fired. */
        if (this.client.cluster.maintenance && this.dev) this.logger.debug("Started in maintenance mode.");

        this.client.cluster.on("ready", async () => {
            const steps: BotSetupStep[] = [ 
                {
                    name: "Stable Horde",
                    execute: async () => this.image.setup()
                },
    
                {
                    name: "Replicate",
                    execute: async () => this.replicate.setup()
                },
    
                {
                    name: "Supabase database",
                    execute: async () => this.db.setup()
                },
    
                {
                    name: "Conversation sessions",
                    execute: async () => this.conversation.setup()
                },
    
                {
                    name: "Scheduled tasks",
                    execute: () => this.task.setup()
                },

                {
                    name: "Load Discord commands",
                    execute: async () => this.command.loadAll()
                },

                {
                    name: "Load Discord interactions",
                    execute: async () => this.interaction.loadAll()
                },

                {
                    name: "Register Discord commands",
                    check: () => this.data.id === 0,
                    execute: () => this.command.register()
                },

                {
                    name: "Load Discord events",
                    execute: () => Utils.search("./build/events", "js")
                        .then(files => files.forEach(path => {
                            /* Name of the event */
                            const name: string = basename(path).split(".")[0];
    
                            import(path)
                                .then((data: { [key: string]: Event }) => {
                                    const event: Event = new (data.default as any)(this);
                                    
                                    this.client.on(event.name, (...args: any[]) => {
                                        try {
                                            event.run(...args);
                                        } catch (error) {
                                            this.logger.error(`Failed to call event ${chalk.bold(name)} ->`, error)
                                        }
                                    });
                                })
                                .catch(error => this.logger.warn(`Failed to load event ${chalk.bold(name)} ->`, error));
                        }))
                }
            ];
    
            /* Execute all of the steps asynchronously, in order. */
            for (const [ index, step ] of steps.entries()) {
                try {
                    /* Whether the step should be executed */
                    const check: boolean = step.check ? await step.check() : true;
    
                    /* Execute the step. */
                    if (check) await step.execute();
                    if (this.dev) this.logger.debug(`Executed configuration step ${chalk.bold(step.name)}. [${chalk.bold(index + 1)}/${chalk.bold(steps.length)}]`);
    
                } catch (error) {
                    this.logger.error(`Failed to execute configuration step ${chalk.bold(step.name)} ->`, error);
                    this.stop(1);
                }
            }
        });

        /* Wait for all application data first. */
        await this.waitForData()
            .catch(() => this.stop(1));

        /* Wait for the bot to fully start. */
        this.waitForDone();

        /* Finally, log into Discord with the bot. */
        await this.client.login(this.app.config.discord.token)
            .catch(error => {
                this.logger.error(`Failed to log into to Discord ->`, error);
                this.stop(1);
            });

        this.logger.info(`Started on ${chalk.bold(this.client.user.username)}.`);

        if (!this.started) {
            this.once("started", () => {
                setInterval(() => chooseStatusMessage(this), 3 * 60 * 1000);
                chooseStatusMessage(this);
            });

        } else {
            setInterval(() => chooseStatusMessage(this), 3 * 60 * 1000);
            chooseStatusMessage(this);
        }
    }

    public async stop(code: number = 0): Promise<never> {
        if (code === 0) this.logger.debug("Stopped.");
        else this.logger.error("An unexpected error occurred, stopping cluster ...");

        process.exit(code);
    }

    /**
     * Change the current status of the bot.
     * @param status New status
     */
    public async changeStatus(status: Omit<BotStatus, "since">): Promise<void> {
        /* If the status is already set to the specified one, ignore it. */
        if ((await this.status()).type === status.type) return;

        /* Set the status on the manager, changing it for all clusters. */
        await this.client.cluster.evalOnManager(
            ((manager: BotClusterManager, context: BotStatus) => manager.bot.status = context) as any,
            { context: { ...status, since: Date.now() } }
        );
    }

    /**
     * Current status of the bot
     */
    public async status(): Promise<BotStatus> {
        //const status: BotStatus = (await this.client.cluster.evalOnManager(
        //    ((manager: BotClusterManager) => manager.bot.status) as any)
        //) as unknown as BotStatus;
        
        //return status;

        return {
            type: "operational", since: this.since
        };
    }

    /**
     * Whether the bot has started
     */
    public get started(): boolean {
        return this.since !== -1;
    }

    /**
     * Whether the bot is currently reloading
     */
    public get reloading(): boolean {
        return !this.started || this.statistics.memoryUsage === 0;
    }

    /**
     * Whether development mode is enabled
     */
    public get dev(): boolean {
        return this.app ? this.app.config.dev : false;
    }

    /**
     * Branding settings for the bot
     */
    public get branding(): ConfigBranding {
        return this.app.config.branding;
    }
}

/* Initialize this bot class. */
const bot: Bot = new Bot();
bot.setup();