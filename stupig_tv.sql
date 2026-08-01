-- phpMyAdmin SQL Dump
-- version 5.2.3
-- https://www.phpmyadmin.net/
--
-- Host: 1Panel-mysql
-- Generation Time: Jul 27, 2026 at 09:00 AM
-- Server version: 8.4.8
-- PHP Version: 8.3.30

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `stupig_tv`
--

-- --------------------------------------------------------

--
-- Table structure for table `content_stories`
--

CREATE TABLE `content_stories` (
  `id` bigint UNSIGNED NOT NULL,
  `title` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `rating` tinyint UNSIGNED NOT NULL,
  `event_precision` enum('day','month') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `event_dates` json NOT NULL,
  `markdown` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_by` bigint UNSIGNED DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `content_story_attachments`
--

CREATE TABLE `content_story_attachments` (
  `id` bigint UNSIGNED NOT NULL,
  `story_id` bigint UNSIGNED NOT NULL,
  `file_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `mime_type` varchar(127) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `file_size` bigint UNSIGNED NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `otp_send_logs`
--

CREATE TABLE `otp_send_logs` (
  `id` bigint UNSIGNED NOT NULL,
  `identity_token` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `phone` char(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `purpose` enum('login','register','change_password','change_phone','verify_old_phone') COLLATE utf8mb4_unicode_ci NOT NULL,
  `requested_at` timestamp NOT NULL,
  `cooldown_until` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` bigint UNSIGNED NOT NULL,
  `username` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `phone` char(11) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `avatar_file` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `birthday` timestamp NULL DEFAULT NULL,
  `is_verified` tinyint(1) NOT NULL DEFAULT '0',
  `verified_note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_admin` tinyint(1) NOT NULL DEFAULT '0',
  `is_banned` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `user_login_sessions`
--

CREATE TABLE `user_login_sessions` (
  `id` bigint UNSIGNED NOT NULL,
  `user_id` bigint UNSIGNED NOT NULL,
  `token_hash` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `identity_token` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_logged_out` tinyint(1) NOT NULL DEFAULT '0',
  `login_at` timestamp NOT NULL,
  `last_seen_at` timestamp NOT NULL,
  `logout_at` timestamp NULL DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  `login_ip` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_seen_ip` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_agent` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `content_stories`
--
ALTER TABLE `content_stories`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_content_stories_updated_at` (`updated_at`),
  ADD KEY `idx_content_stories_created_by` (`created_by`);

--
-- Indexes for table `content_story_attachments`
--
ALTER TABLE `content_story_attachments`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_content_story_attachments_story_file` (`story_id`,`file_name`);

--
-- Indexes for table `otp_send_logs`
--
ALTER TABLE `otp_send_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_otp_send_logs_identity_day` (`identity_token`,`requested_at`),
  ADD KEY `idx_otp_send_logs_phone_day` (`phone`,`requested_at`),
  ADD KEY `idx_otp_send_logs_cooldown_until` (`cooldown_until`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`),
  ADD UNIQUE KEY `phone` (`phone`),
  ADD KEY `idx_users_is_verified` (`is_verified`),
  ADD KEY `idx_users_is_admin` (`is_admin`),
  ADD KEY `idx_users_birthday` (`birthday`),
  ADD KEY `idx_users_created_at` (`created_at`),
  ADD KEY `idx_users_is_banned` (`is_banned`);

--
-- Indexes for table `user_login_sessions`
--
ALTER TABLE `user_login_sessions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user_login_sessions_user_login` (`user_id`,`login_at`),
  ADD KEY `idx_user_login_sessions_expires_at` (`expires_at`),
  ADD KEY `idx_user_login_sessions_user_logout_seen` (`user_id`,`is_logged_out`,`last_seen_at`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `content_stories`
--
ALTER TABLE `content_stories`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `content_story_attachments`
--
ALTER TABLE `content_story_attachments`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `otp_send_logs`
--
ALTER TABLE `otp_send_logs`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `user_login_sessions`
--
ALTER TABLE `user_login_sessions`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `content_stories`
--
ALTER TABLE `content_stories`
  ADD CONSTRAINT `fk_content_stories_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

--
-- Constraints for table `content_story_attachments`
--
ALTER TABLE `content_story_attachments`
  ADD CONSTRAINT `fk_content_story_attachments_story` FOREIGN KEY (`story_id`) REFERENCES `content_stories` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `user_login_sessions`
--
ALTER TABLE `user_login_sessions`
  ADD CONSTRAINT `fk_user_login_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
