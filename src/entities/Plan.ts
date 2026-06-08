import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm";
import { Subscription } from "./Subscription";

export enum PlanType {
  FREE = "free",
  MONTHLY = "monthly",
  QUARTERLY = "quarterly",
  YEARLY = "yearly",
}

@Entity()
export class Plan {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text", unique: true })
  name: string;

  @Column({
    type: "simple-enum",
    enum: PlanType,
  })
  type: PlanType;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  price: number;

  @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
  discount: number;

  @Column({ type: "text", nullable: true })
  description: string;

  @Column({ type: "boolean", default: true })
  isActive: boolean;

  @Column({ type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;

  @OneToMany(() => Subscription, (subscription) => subscription.plan)
  subscriptions: Subscription[];

  getDurationDays(): number {
    switch (this.type) {
      case PlanType.FREE:
        return 0;
      case PlanType.MONTHLY:
        return 30;
      case PlanType.QUARTERLY:
        return 90;
      case PlanType.YEARLY:
        return 365;
      default:
        return 30;
    }
  }

  getActualPrice(): number {
    return Number((this.price * (1 - this.discount / 100)).toFixed(2));
  }
}
