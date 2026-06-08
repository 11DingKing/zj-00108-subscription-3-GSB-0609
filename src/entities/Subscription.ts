import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany } from "typeorm";
import { User } from "./User";
import { Plan } from "./Plan";
import { Bill } from "./Bill";

export enum SubscriptionStatus {
  TRIAL = "trial",
  ACTIVE = "active",
  EXPIRED = "expired",
  CANCELLED = "cancelled",
  GRACE_PERIOD = "grace_period",
}

@Entity()
export class Subscription {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.subscriptions)
  user: User;

  @ManyToOne(() => Plan, (plan) => plan.subscriptions)
  plan: Plan;

  @Column({ type: "datetime" })
  startDate: Date;

  @Column({ type: "datetime" })
  endDate: Date;

  @Column({ type: "boolean", default: true })
  autoRenew: boolean;

  @Column({
    type: "simple-enum",
    enum: SubscriptionStatus,
    default: SubscriptionStatus.ACTIVE,
  })
  status: SubscriptionStatus;

  @Column({ type: "datetime", nullable: true })
  gracePeriodEnd: Date | null;

  @Column({ type: "int", nullable: true })
  pendingDowngradePlanId: number | null;

  @Column({ type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;

  @OneToMany(() => Bill, (bill) => bill.subscription)
  bills: Bill[];

  isInGracePeriod(): boolean {
    if (!this.gracePeriodEnd) return false;
    return new Date() <= this.gracePeriodEnd;
  }
}
