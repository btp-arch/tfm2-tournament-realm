export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      disputes: {
        Row: {
          assigned_to: string | null
          created_at: string
          id: string
          match_id: string
          opened_by: string
          reason: string
          resolution: string | null
          resolved_at: string | null
          status: Database["public"]["Enums"]["dispute_status"]
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          id?: string
          match_id: string
          opened_by: string
          reason: string
          resolution?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["dispute_status"]
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          id?: string
          match_id?: string
          opened_by?: string
          reason?: string
          resolution?: string | null
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["dispute_status"]
        }
        Relationships: [
          {
            foreignKeyName: "disputes_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      match_confirmations: {
        Row: {
          created_at: string
          id: string
          match_report_id: string
          notes: string | null
          status: Database["public"]["Enums"]["confirmation_status"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          match_report_id: string
          notes?: string | null
          status: Database["public"]["Enums"]["confirmation_status"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          match_report_id?: string
          notes?: string | null
          status?: Database["public"]["Enums"]["confirmation_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_confirmations_match_report_id_fkey"
            columns: ["match_report_id"]
            isOneToOne: false
            referencedRelation: "match_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_confirmations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      match_events: {
        Row: {
          actor_id: string | null
          created_at: string
          event_type: Database["public"]["Enums"]["match_event_type"]
          id: string
          match_id: string
          metadata: Json
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          event_type: Database["public"]["Enums"]["match_event_type"]
          id?: string
          match_id: string
          metadata?: Json
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          event_type?: Database["public"]["Enums"]["match_event_type"]
          id?: string
          match_id?: string
          metadata?: Json
        }
        Relationships: [
          {
            foreignKeyName: "match_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_events_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
        ]
      }
      match_evidence: {
        Row: {
          caption: string | null
          created_at: string
          id: string
          match_report_id: string
          storage_path: string
          uploaded_by: string
        }
        Insert: {
          caption?: string | null
          created_at?: string
          id?: string
          match_report_id: string
          storage_path: string
          uploaded_by: string
        }
        Update: {
          caption?: string | null
          created_at?: string
          id?: string
          match_report_id?: string
          storage_path?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_evidence_match_report_id_fkey"
            columns: ["match_report_id"]
            isOneToOne: false
            referencedRelation: "match_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_evidence_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      match_reports: {
        Row: {
          created_at: string
          id: string
          match_id: string
          notes: string | null
          outcome: Database["public"]["Enums"]["report_outcome"]
          reporter_id: string
          score_player_one: number
          score_player_two: number
        }
        Insert: {
          created_at?: string
          id?: string
          match_id: string
          notes?: string | null
          outcome: Database["public"]["Enums"]["report_outcome"]
          reporter_id: string
          score_player_one?: number
          score_player_two?: number
        }
        Update: {
          created_at?: string
          id?: string
          match_id?: string
          notes?: string | null
          outcome?: Database["public"]["Enums"]["report_outcome"]
          reporter_id?: string
          score_player_one?: number
          score_player_two?: number
        }
        Relationships: [
          {
            foreignKeyName: "match_reports_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      matches: {
        Row: {
          check_in_opens_at: string | null
          created_at: string
          format: Database["public"]["Enums"]["match_format"]
          host_side_choice: Database["public"]["Enums"]["side_choice"] | null
          host_user_id: string | null
          id: string
          player_one_id: string
          player_two_id: string
          round_number: number
          scheduled_at: string | null
          status: Database["public"]["Enums"]["match_status"]
          tournament_id: string
          updated_at: string
          winner_id: string | null
        }
        Insert: {
          check_in_opens_at?: string | null
          created_at?: string
          format?: Database["public"]["Enums"]["match_format"]
          host_side_choice?: Database["public"]["Enums"]["side_choice"] | null
          host_user_id?: string | null
          id?: string
          player_one_id: string
          player_two_id: string
          round_number?: number
          scheduled_at?: string | null
          status?: Database["public"]["Enums"]["match_status"]
          tournament_id: string
          updated_at?: string
          winner_id?: string | null
        }
        Update: {
          check_in_opens_at?: string | null
          created_at?: string
          format?: Database["public"]["Enums"]["match_format"]
          host_side_choice?: Database["public"]["Enums"]["side_choice"] | null
          host_user_id?: string | null
          id?: string
          player_one_id?: string
          player_two_id?: string
          round_number?: number
          scheduled_at?: string | null
          status?: Database["public"]["Enums"]["match_status"]
          tournament_id?: string
          updated_at?: string
          winner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matches_host_user_id_fkey"
            columns: ["host_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_player_one_id_fkey"
            columns: ["player_one_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_player_two_id_fkey"
            columns: ["player_two_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_winner_id_fkey"
            columns: ["winner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organizer_feedback: {
        Row: {
          comments: string | null
          created_at: string
          id: string
          organizer_id: string
          rating: number | null
          submitted_by: string
          tournament_id: string
        }
        Insert: {
          comments?: string | null
          created_at?: string
          id?: string
          organizer_id: string
          rating?: number | null
          submitted_by: string
          tournament_id: string
        }
        Update: {
          comments?: string | null
          created_at?: string
          id?: string
          organizer_id?: string
          rating?: number | null
          submitted_by?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizer_feedback_organizer_id_fkey"
            columns: ["organizer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizer_feedback_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizer_feedback_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_roles: {
        Row: {
          created_at: string
          granted_by: string | null
          role: Database["public"]["Enums"]["platform_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          role: Database["public"]["Enums"]["platform_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          role?: Database["public"]["Enums"]["platform_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_roles_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "platform_roles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          bio: string | null
          created_at: string
          display_name: string
          id: string
          tfm2_handle: string | null
          updated_at: string
        }
        Insert: {
          bio?: string | null
          created_at?: string
          display_name: string
          id: string
          tfm2_handle?: string | null
          updated_at?: string
        }
        Update: {
          bio?: string | null
          created_at?: string
          display_name?: string
          id?: string
          tfm2_handle?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      tournament_organizers: {
        Row: {
          created_at: string
          tournament_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          tournament_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          tournament_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_organizers_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_organizers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_registrations: {
        Row: {
          created_at: string
          id: string
          seed: number | null
          status: Database["public"]["Enums"]["registration_status"]
          tournament_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          seed?: number | null
          status?: Database["public"]["Enums"]["registration_status"]
          tournament_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          seed?: number | null
          status?: Database["public"]["Enums"]["registration_status"]
          tournament_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_registrations_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_registrations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tournaments: {
        Row: {
          created_at: string
          created_by: string
          description: string | null
          format: Database["public"]["Enums"]["match_format"]
          id: string
          max_players: number | null
          name: string
          rules: string | null
          slug: string
          starts_at: string | null
          status: Database["public"]["Enums"]["tournament_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string | null
          format?: Database["public"]["Enums"]["match_format"]
          id?: string
          max_players?: number | null
          name: string
          rules?: string | null
          slug: string
          starts_at?: string | null
          status?: Database["public"]["Enums"]["tournament_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string | null
          format?: Database["public"]["Enums"]["match_format"]
          id?: string
          max_players?: number | null
          name?: string
          rules?: string | null
          slug?: string
          starts_at?: string | null
          status?: Database["public"]["Enums"]["tournament_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournaments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_admin: { Args: never; Returns: boolean }
      is_match_participant: { Args: { match: string }; Returns: boolean }
      is_organizer_for: { Args: { tournament: string }; Returns: boolean }
    }
    Enums: {
      confirmation_status: "confirmed" | "disputed"
      dispute_status: "open" | "under_review" | "resolved" | "rejected"
      match_event_type:
        | "status_changed"
        | "check_in"
        | "host_assigned"
        | "host_setup"
        | "guest_joined"
        | "game_started"
        | "result_reported"
        | "confirmed"
        | "disputed"
        | "resolved"
        | "note"
      match_format: "bo1" | "bo3" | "bo5"
      match_status:
        | "assigned"
        | "check_in_open"
        | "awaiting_host_setup"
        | "awaiting_guest_join"
        | "in_game"
        | "result_reported"
        | "confirmed"
        | "disputed"
        | "replay_required"
        | "forfeit"
        | "finalized"
      platform_role: "player" | "organizer" | "admin"
      registration_status:
        | "pending"
        | "checked_in"
        | "withdrawn"
        | "accepted"
        | "rejected"
      report_outcome:
        | "player_one_win"
        | "player_two_win"
        | "forfeit_player_one"
        | "forfeit_player_two"
        | "replay_required"
      side_choice: "red" | "blue"
      tournament_status:
        | "draft"
        | "published"
        | "registration_open"
        | "registration_closed"
        | "in_progress"
        | "completed"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      confirmation_status: ["confirmed", "disputed"],
      dispute_status: ["open", "under_review", "resolved", "rejected"],
      match_event_type: [
        "status_changed",
        "check_in",
        "host_assigned",
        "host_setup",
        "guest_joined",
        "game_started",
        "result_reported",
        "confirmed",
        "disputed",
        "resolved",
        "note",
      ],
      match_format: ["bo1", "bo3", "bo5"],
      match_status: [
        "assigned",
        "check_in_open",
        "awaiting_host_setup",
        "awaiting_guest_join",
        "in_game",
        "result_reported",
        "confirmed",
        "disputed",
        "replay_required",
        "forfeit",
        "finalized",
      ],
      platform_role: ["player", "organizer", "admin"],
      registration_status: [
        "pending",
        "checked_in",
        "withdrawn",
        "accepted",
        "rejected",
      ],
      report_outcome: [
        "player_one_win",
        "player_two_win",
        "forfeit_player_one",
        "forfeit_player_two",
        "replay_required",
      ],
      side_choice: ["red", "blue"],
      tournament_status: [
        "draft",
        "published",
        "registration_open",
        "registration_closed",
        "in_progress",
        "completed",
        "cancelled",
      ],
    },
  },
} as const
