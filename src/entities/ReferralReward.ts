import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from "typeorm";
import { User } from "./User";
import { Bill } from "./Bill";

@Entity()
export class ReferralReward {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User)
  referrer: User;

  @ManyToOne(() => User)
  referredUser: User;

  @ManyToOne(() => Bill)
  bill: Bill;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  amount: number;

  @Column({ type: "decimal", precision: 5, scale: 2, default: 10 })
  percentage: number;

  @Column({ type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;
}
