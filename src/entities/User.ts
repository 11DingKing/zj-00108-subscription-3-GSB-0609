import { Entity, PrimaryGeneratedColumn, Column, OneToMany, ManyToOne, BeforeInsert } from "typeorm";
import { Subscription } from "./Subscription";
import { Bill } from "./Bill";

export enum UserRole {
  ADMIN = "admin",
  USER = "user",
}

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text", unique: true })
  username: string;

  @Column({ type: "text" })
  password: string;

  @Column({
    type: "simple-enum",
    enum: UserRole,
    default: UserRole.USER,
  })
  role: UserRole;

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
  balance: number;

  @Column({ type: "boolean", default: true })
  isActive: boolean;

  @Column({ type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;

  @Column({ type: "text", unique: true, nullable: true })
  referralCode: string | null;

  @ManyToOne(() => User, { nullable: true })
  referredBy: User | null;

  @Column({ type: "boolean", default: false })
  hasReceivedFirstReward: boolean;

  @OneToMany(() => Subscription, (subscription) => subscription.user)
  subscriptions: Subscription[];

  @OneToMany(() => Bill, (bill) => bill.user)
  bills: Bill[];

  @BeforeInsert()
  generateReferralCode() {
    if (!this.referralCode) {
      this.referralCode = Math.random().toString(36).substring(2, 10).toUpperCase();
    }
  }
}
