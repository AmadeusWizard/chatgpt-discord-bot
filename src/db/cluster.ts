import { ClusterDatabaseMetricsManager } from "./managers/metrics.js";
import { UserSettingsManager } from "./managers/settings.js";
import { StorageManager } from "./managers/storage.js";
import { UserRoleManager } from "./managers/role.js";
import { CacheManager } from "./managers/cache.js";
import { UserManager } from "./managers/user.js";
import { PlanManager } from "./managers/plan.js";
import { DatabaseManager } from "./manager.js";

import { type Bot } from "../bot/bot.js";

export class ClientDatabaseManager extends DatabaseManager<Bot> {
    /* Various sub-managers */
    public readonly metrics: ClusterDatabaseMetricsManager;
    public readonly settings: UserSettingsManager;
    public readonly storage: StorageManager;
    public readonly role: UserRoleManager;
    public readonly cache: CacheManager;
    public readonly users: UserManager;
    public readonly plan: PlanManager;

    constructor(bot: any) {
        super(bot);

        this.metrics = new ClusterDatabaseMetricsManager(this);
        this.settings = new UserSettingsManager(this);
        this.storage = new StorageManager(this);
        this.role = new UserRoleManager(this);
        this.cache = new CacheManager(this);
        this.users = new UserManager(this);
        this.plan = new PlanManager(this);
    }

    public async setup(): Promise<void> {
        await super.setup();

        /* Set up the various sub-managers. */
        await this.storage.setup();
    }
}