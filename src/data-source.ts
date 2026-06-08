import "reflect-metadata";
import { DataSource } from "typeorm";
import { User } from "./entities/User";
import { Plan } from "./entities/Plan";
import { Subscription } from "./entities/Subscription";
import { Bill } from "./entities/Bill";
import { Coupon } from "./entities/Coupon";
import { Referral } from "./entities/Referral";
import { ReferralReward } from "./entities/ReferralReward";

export const AppDataSource = new DataSource({
  type: "better-sqlite3",
  database: "./data/app.db",
  synchronize: true,
  logging: false,
  entities: [User, Plan, Subscription, Bill, Coupon, Referral, ReferralReward],
  migrations: [],
  subscribers: [],
});
